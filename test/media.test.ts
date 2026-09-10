import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaySession } from "../host/media.ts";
import { readStream } from "../host/ring.ts";
import { FileRingSink } from "../host/sink.ts";
import type { ResolvedStream } from "../host/yt.ts";

const tmp = mkdtempSync(join(tmpdir(), "pocket-youtube-media-"));
const fixture = join(tmp, "source.mov");
const geo = { w: 64, h: 32, fpsNum: 12, fpsDen: 1, slotCount: 8, sampleRate: 22050, channels: 2 as const, chunkFrames: 2048, chunkCount: 64, totalFrames: 36 };
const source = (url: string): ResolvedStream => ({ videoId: "fixture", title: "Fixture", channel: "Test", durationS: 3, videoUrl: url, audioUrl: url, thumbnail: "", width: 64, height: 32 });

beforeAll(async () => {
  const proc = Bun.spawn([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=256x128:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050", "-t", "3",
    "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-c:a", "aac", "-movflags", "+faststart", fixture,
  ], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if (await proc.exited) throw new Error(stderr);
  const split = Bun.spawn([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", fixture,
    "-map", "0:v", "-c", "copy", join(tmp, "video.mov"),
    "-map", "0:a", "-c", "copy", join(tmp, "audio.m4a"),
  ], { stdout: "ignore", stderr: "pipe" });
  const splitError = await new Response(split.stderr).text();
  if (await split.exited) throw new Error(splitError);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("separate video-only and audio-only sources both reach the ring", async () => {
  const stream = { ...source(join(tmp, "video.mov")), audioUrl: join(tmp, "audio.m4a") };
  const session = new PlaySession(stream, new FileRingSink(tmp, "adaptive.pkst", geo));
  try {
    await session.ready;
    const ring = readStream(join(tmp, "adaptive.pkst"));
    expect(ring.videoLatest).toBeGreaterThan(0);
    expect(ring.audioLatest).toBeGreaterThan(0);
    expect(ring.chunks.some((c) => c.pcm.some((v) => v !== 0))).toBe(true);
  } finally { session.close(); }
});

test("bounded HTTP ranges produce video and audio before playback is ready", async () => {
  const bytes = await Bun.file(fixture).bytes();
  const ranges: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const range = req.headers.get("range") ?? "";
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      // Reproduce the CDN: unbounded FFmpeg requests are rejected.
      if (!match) return new Response("bounded range required", { status: 403 });
      const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Accept-Ranges": "bytes" },
      });
    },
  });
  let ended = 0;
  const sink = new FileRingSink(tmp, "bounded.pkst", geo);
  const session = new PlaySession(source(`http://127.0.0.1:${server.port}/video`), sink, { onEnd: () => ended++ });
  try {
    expect(readStream(join(tmp, "bounded.pkst")).videoLatest).toBe(0);
    await session.ready;
    const ring = readStream(join(tmp, "bounded.pkst"));
    expect(ring.videoLatest).toBeGreaterThan(0);
    expect(ring.audioLatest).toBeGreaterThan(0);
    expect(ring.frames.some((f) => f.indices.some((v) => v !== 0))).toBe(true);
    expect(ring.chunks.some((c) => c.pcm.some((v) => v !== 0))).toBe(true);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(ranges.every((range) => /^bytes=\d+-\d+$/.test(range))).toBe(true);
    expect(ended).toBe(0);
    const deadline = Date.now() + 5000;
    while (!ended && Date.now() < deadline) await Bun.sleep(20);
    expect(ended).toBe(1);
    expect(ranges.some((range) => Number(/^bytes=(\d+)-/.exec(range)?.[1]) >= 1048576)).toBe(true);
  } finally {
    session.close();
    server.stop(true);
  }
}, 10_000);

test("decoder failure rejects startup instead of reporting normal EOF", async () => {
  let ended = 0;
  const session = new PlaySession(source(join(tmp, "missing.mp4")), new FileRingSink(tmp, "missing.pkst", geo), { onEnd: () => ended++ });
  try {
    await expect(session.ready).rejects.toThrow(/decoder failed.*No such file/s);
    expect(ended).toBe(0);
  } finally { session.close(); }
});

test("a truncated source that decoded frames fails instead of reporting normal EOF", async () => {
  const bytes = await Bun.file(fixture).bytes();
  const path = join(tmp, "truncated.mp4");
  await Bun.write(path, bytes.slice(0, Math.floor(bytes.length * 0.8)));
  let failure = "", ended = 0;
  const session = new PlaySession(source(path), new FileRingSink(tmp, "truncated.pkst", geo), {
    onError: (message) => { failure = message; },
    onEnd: () => ended++,
  });
  try {
    await session.ready;
    const deadline = Date.now() + 5000;
    while (!failure && Date.now() < deadline) await Bun.sleep(20);
    expect(failure).toMatch(/decoder failed/);
    expect(ended).toBe(0);
    expect(readStream(join(tmp, "truncated.pkst")).ended).toBe(false);
  } finally { session.close(); }
}, 10_000);

test("a failed seek reports a playback error without treating the replaced decoder as EOF", async () => {
  const path = join(tmp, "removed.mp4");
  await Bun.write(path, Bun.file(fixture));
  let failure = "", ended = 0;
  const session = new PlaySession(source(path), new FileRingSink(tmp, "seek.pkst", geo), {
    onError: (message) => { failure = message; },
    onEnd: () => ended++,
  });
  try {
    await session.ready;
    rmSync(path);
    session.seek(1);
    const deadline = Date.now() + 2000;
    while (!failure && Date.now() < deadline) await Bun.sleep(20);
    expect(failure).toMatch(/decoder failed.*No such file/s);
    expect(ended).toBe(0);
  } finally { session.close(); }
});

test("startup without media times out and closing a pending session cancels readiness", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  const session = new PlaySession(source(`http://127.0.0.1:${server.port}/stall`), new FileRingSink(tmp, "stall.pkst", geo), {}, { startupTimeoutMs: 250 });
  try {
    await expect(session.ready).rejects.toThrow("Timed out waiting for video and audio");
  } finally { session.close(); server.stop(true); }
  const cancelled = new PlaySession(source(fixture), new FileRingSink(tmp, "cancelled.pkst", geo));
  cancelled.close();
  await expect(cancelled.ready).rejects.toThrow("Playback cancelled");
});
