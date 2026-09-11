import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeFit, nativeMedia, accessUnits } from "../host/native-media.ts";
import type { ResolvedStream } from "../host/yt.ts";
import { MEDIA } from "../vendor/pocketjs/contracts/spec/media.ts";

const directory = mkdtempSync(join(tmpdir(), "pocket-youtube-native-"));
const fixture = join(directory, "fixture.mp4");
beforeAll(async () => {
  const process = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", fixture], { stdout: "ignore", stderr: "pipe" });
  expect(await process.exited).toBe(0);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const source = (): ResolvedStream => ({ videoId: "fixture0001", title: "Fixture", channel: "Test", durationS: 3,
  videoUrl: fixture, audioUrl: fixture, thumbnail: "", width: 640, height: 360 });

test("wide, portrait and square sources fit in display pixels without stretching", () => {
  for (const [w, h] of [[1920, 1080], [1080, 1920], [640, 640]]) {
    const fit = nativeFit(w, h);
    expect(fit.w % 2).toBe(0); expect(fit.h % 2).toBe(0);
    expect(Math.abs((fit.w / 512 * 400) / (fit.h / 256 * 240) - w / h)).toBeLessThan(.02);
  }
});

test("Annex B access-unit framing survives every pipe split", async () => {
  const units = [Buffer.from([0, 0, 0, 1, 9, 240, 0, 0, 1, 5, 42]), Buffer.from([0, 0, 1, 9, 240, 0, 0, 1, 1, 77])];
  const bytes = Buffer.concat(units);
  for (let split = 1; split < bytes.length; split++) {
    async function* input() { yield bytes.subarray(0, split); yield bytes.subarray(split); }
    const result = [];
    for await (const unit of accessUnits(input())) result.push(Buffer.from(unit));
    expect(result).toEqual(units);
  }
});

test("real encoder produces decodable baseline video and timestamped audio below the Wi-Fi budget", async () => {
  const video: Uint8Array[] = [];
  let audioBytes = 0, videoFrames = 0, audioFrames = 0, previous = 0;
  for await (const packet of nativeMedia(source(), 0, new AbortController().signal)) {
    expect(packet.ptsMs).toBeGreaterThanOrEqual(previous); previous = packet.ptsMs;
    if (packet.kind === 1) {
      video.push(packet.data); videoFrames++; expect(packet.data.length).toBeLessThanOrEqual(MEDIA.packetBytes);
      // Inspect the encoded bitstream, since zerolatency sliced threading can
      // override slices=1 while ffprobe still reports valid baseline H.264.
      const bytes = packet.data, slices: number[] = [];
      for (let i = 0; i + 3 < bytes.length; i++) {
        if (bytes[i] || bytes[i + 1]) continue;
        const prefix = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
        if (!prefix) continue;
        const type = bytes[i + prefix] & 31;
        if (type >= 1 && type <= 5) slices.push(type);
        i += prefix - 1;
      }
      expect(slices, `frame ${videoFrames} must contain one complete slice`).toHaveLength(1);
      if (videoFrames === 1) expect(slices[0]).toBe(5);
    }
    else { audioBytes += packet.data.length; audioFrames += packet.data.length - 7; }
  }
  expect(videoFrames).toBe(90);
  expect(audioFrames).toBeGreaterThanOrEqual(3 * 22050);
  const path = join(directory, "output.h264"), bytes = Buffer.concat(video); writeFileSync(path, bytes);
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_streams", "-of", "json", path]);
  const stream = JSON.parse(probe.stdout.toString()).streams[0];
  expect(stream.profile).toBe("Constrained Baseline"); expect(stream.has_b_frames).toBe(0);
  expect([stream.width, stream.height]).toEqual([512, 256]);
  expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"]).exitCode).toBe(0);
  const bitsPerSecond = (bytes.length + audioBytes + (videoFrames + Math.ceil(audioFrames / 1024)) * 16) * 8 / 3;
  expect(bitsPerSecond).toBeLessThan(1_000_000);
  console.log(`Native fixture: ${videoFrames} video frames, ${audioFrames} audio frames, ${Math.round(bitsPerSecond)} bit/s`);
}, 20000);

test("seek starts with an independent keyframe and cancellation stops both encoders", async () => {
  const abort = new AbortController();
  const iterator = nativeMedia(source(), 1, abort.signal);
  const first = await iterator.next();
  expect(first.done).toBe(false); expect(first.value!.ptsMs).toBe(1000);
  expect(first.value!.kind).toBe(1);
  abort.abort(); await iterator.return(undefined);
}, 10000);

test("companion H.264 preserves primary colors and skin-tone channel order", async () => {
  const colors = [[230, 25, 20], [20, 220, 30], [20, 30, 230], [225, 185, 25], [215, 165, 115]];
  const rgb = Buffer.alloc(400 * 240 * 3);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) rgb.set(colors[Math.floor(x / 80)], (y * 400 + x) * 3);
  const ppm = join(directory, "colors.ppm"), clip = join(directory, "colors.mp4");
  writeFileSync(ppm, Buffer.concat([Buffer.from("P6\n400 240\n255\n"), rgb]));
  const encode = Bun.spawn(["ffmpeg", "-v", "error", "-loop", "1", "-i", ppm, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip], { stdout: "ignore", stderr: "pipe" });
  expect(await encode.exited).toBe(0);
  const units: Buffer[] = [];
  for await (const packet of nativeMedia({ ...source(), width: 400, height: 240, videoUrl: clip, audioUrl: clip }, 0, new AbortController().signal))
    if (packet.kind === 1) units.push(Buffer.from(packet.data));
  const decode = Bun.spawn(["ffmpeg", "-v", "error", "-f", "h264", "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
    { stdin: new Blob([Buffer.concat(units)]), stdout: "pipe", stderr: "pipe" });
  const pixels = new Uint8Array(await new Response(decode.stdout).arrayBuffer());
  expect(await decode.exited).toBe(0); expect(pixels.length).toBe(512 * 256 * 3);
  for (let patch = 0; patch < colors.length; patch++) for (let channel = 0; channel < 3; channel++) {
    const actual = pixels[(128 * 512 + Math.floor((patch + .5) * 512 / 5)) * 3 + channel];
    expect(Math.abs(actual - colors[patch][channel])).toBeLessThan(12);
  }
});
