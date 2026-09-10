// demos/youtube/host/media.ts — the play pipeline: YouTube -> .pkst rings.
//
// Two ffmpeg processes per session, pulling the resolved video/audio tracks
// (or the same progressive URL when the source is muxed):
//
//   video: -re -ss S -i URL -vf fps/scale/pad -> rawvideo rgb24 pipe
//          -> quantize (CLUT8 + dither) -> StreamWriter.writeFrame
//   audio: -re -ss S -i URL -> s16le 22.05 kHz stereo pipe
//          -> exact chunkFrames chunks -> StreamWriter.writeAudio
//
// `-re` paces both pipes at source rate, so "the writer writes in real time"
// falls out of ffmpeg and the device's latest-seq chase IS the play clock.
// pause = SIGSTOP (the pipes stall, rings freeze), resume = respawn,
// seek = kill + respawn at the new offset + epoch bump (the device drops its
// ring positions and re-syncs to the tail).
//
// The plane geometry comes from the device profile (profiles.ts): the PSP
// keeps its tuned 512x128@12 defaults; the Vita negotiates 512x256@24 at
// hello. Frames are PRE-SQUASHED for the 480x272 logical stretch: content
// letterboxed for the final screen aspect, not the texture's own aspect —
// see planeBox(). Output lands in a StreamSink (sink.ts): the PSP's ring
// FILE or the Vita's TCP slot push, same geometry either way.

import { ffmpegProxyArgs, proxyEnv } from "./proxy.ts";
import { quantize, paletteBytes } from "./quant.ts";
import type { StreamSink } from "./sink.ts";
import type { ResolvedStream } from "./yt.ts";

/**
 * Content box inside the plane for a source aspect ratio: the plane is
 * stretched to the full 480x272 screen, so the box must letterbox in SCREEN
 * space and then map back into plane texels. For a 16:9 source the error vs
 * a true screen-space letterbox is sub-pixel — effectively full plane.
 */
export function planeBox(
  srcW: number,
  srcH: number,
  planeW: number,
  planeH: number,
): { w: number; h: number } {
  const screenW = 480;
  const screenH = 272;
  const fit = Math.min(screenW / srcW, screenH / srcH);
  const w = Math.round(((srcW * fit) / screenW) * planeW);
  const h = Math.round(((srcH * fit) / screenH) * planeH);
  return { w: Math.min(planeW, Math.max(16, w & ~1)), h: Math.min(planeH, Math.max(16, h & ~1)) };
}

export interface SessionEvents {
  /** Source exhausted after a successful decode. */
  onEnd?: (reason: string) => void;
  /** A running stream failed; startup failures reject ready instead. */
  onError?: (message: string) => void;
}

export interface SessionOptions {
  startupTimeoutMs?: number;
}

export class PlaySession {
  /** Resolves after both a video frame and an audio chunk reach the sink. */
  readonly ready: Promise<void>;
  readonly stream: ResolvedStream;
  /** svc-relative path the app passes to videoOpen. */
  readonly relPath: string;
  private writer: StreamSink;
  private video: Bun.Subprocess | null = null;
  private audio: Bun.Subprocess | null = null;
  private baseFrame = 0;
  private baseSample = 0;
  /** Newest video frame index written to the ring (the host's play clock). */
  private framesWritten = 0;
  private paused = false;
  private closed = false;
  private events: SessionEvents;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyResolved = false;
  private failed = false;
  private videoReady = false;
  private audioReady = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimeoutMs: number;

  constructor(stream: ResolvedStream, sink: StreamSink, events: SessionEvents = {}, options: SessionOptions = {}) {
    this.stream = stream;
    this.relPath = sink.relPath;
    this.events = events;
    this.writer = sink;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // close/seek can cancel a session before its caller starts awaiting it.
    void this.ready.catch(() => {});
    try {
      this.spawnAt(0);
    } catch (error) {
      this.fail(error);
    }
  }

  private get fps(): number {
    return this.writer.geo.fpsNum / this.writer.geo.fpsDen;
  }

  get positionBase(): number {
    return this.baseFrame / this.fps;
  }

  private spawnAt(seconds: number): void {
    const geo = this.writer.geo;
    this.baseFrame = Math.round(seconds * this.fps);
    this.baseSample = Math.round(seconds * geo.sampleRate);
    const seek = seconds > 0 ? ["-ss", seconds.toFixed(2)] : [];
    this.videoReady = this.audioReady = false;
    this.startupTimer = setTimeout(() => {
      this.fail(new Error("Timed out waiting for video and audio"));
    }, this.startupTimeoutMs);
    // Googlevideo can reject unbounded Range requests with HTTP 403 even
    // when a bounded request for the same signed URL succeeds. Keep each
    // request finite, including the probe before FFmpeg knows the file size.
    const network = (url: string) => /^https?:\/\//.test(url)
      ? [
          ...ffmpegProxyArgs(),
          "-rw_timeout", "10000000",
          "-request_size", "1048576",
          "-initial_request_size", "1048576",
          "-short_seek_size", "1048576",
          "-multiple_requests", "1",
        ]
      : [];
    // Letterbox in SCREEN space, not texture space: the plane's texels are
    // anamorphic (the 512x128 texture stretches to 480x272), so fitting the
    // source into the raw texture box would pillarbox 16:9 into a strip.
    // planeBox maps the true screen-space fit back into texels.
    const box = planeBox(this.stream.width || 16, this.stream.height || 9, geo.w, geo.h);
    this.video = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-re",
        ...network(this.stream.videoUrl),
        ...seek,
        "-i",
        this.stream.videoUrl,
        "-vf",
        // lanczos: the plane is anamorphic (wide texels), so every scrap of
        // horizontal acutance from the 720p source survives to the screen.
        `fps=${this.fps},scale=${box.w}:${box.h}:flags=lanczos,pad=${geo.w}:${geo.h}:(ow-iw)/2:(oh-ih)/2:black`,
        "-an",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...proxyEnv() } },
    );
    this.audio = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-re",
        ...network(this.stream.audioUrl),
        ...seek,
        "-i",
        this.stream.audioUrl,
        "-vn",
        "-ac",
        "2",
        "-ar",
        String(geo.sampleRate),
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...proxyEnv() } },
    );
    const video = this.video;
    const audio = this.audio;
    void this.pumpVideo(video, this.baseFrame, this.readStderr(video)).catch((error) => {
      if (video === this.video) this.fail(error);
    });
    void this.pumpAudio(audio, this.baseSample, this.readStderr(audio)).catch((error) => {
      if (audio === this.audio) this.fail(error);
    });
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private mediaReady(): void {
    if (!this.videoReady || !this.audioReady) return;
    this.clearStartupTimer();
    if (!this.readyResolved) {
      this.readyResolved = true;
      this.resolveReady();
    }
  }

  private fail(error: unknown): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.killProcs();
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!this.readyResolved) this.rejectReady(failure);
    else this.events.onError?.(failure.message);
  }

  /** Drain stderr without retaining an unbounded log or exposing signed URLs. */
  private async readStderr(proc: Bun.Subprocess): Promise<string> {
    if (!(proc.stderr instanceof ReadableStream)) return "";
    const decoder = new TextDecoder();
    let tail = "";
    for await (const part of proc.stderr as ReadableStream<Uint8Array>) {
      tail += decoder.decode(part, { stream: true });
      if (tail.length > 8192) {
        tail = tail.slice(-8192);
        tail = tail.slice(tail.indexOf("\n") + 1);
      }
    }
    return tail.replace(/https?:\/\/\S+/g, "[media URL]").trim().slice(-1000);
  }

  private async pumpVideo(proc: Bun.Subprocess, baseFrame: number, stderr: Promise<string>): Promise<void> {
    const { w: planeW, h: planeH } = this.writer.geo;
    const frameBytes = planeW * planeH * 3;
    const rgba = new Uint8Array(planeW * planeH * 4);
    let pending = new Uint8Array(0);
    let index = 0;
    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) return;
    for await (const part of stdout as ReadableStream<Uint8Array>) {
      if (this.closed || proc !== this.video) return;
      const buf = pending.length ? concat(pending, part) : part;
      let off = 0;
      while (buf.length - off >= frameBytes) {
        const rgb = buf.subarray(off, off + frameBytes);
        off += frameBytes;
        for (let i = 0; i < planeW * planeH; i++) {
          rgba[i * 4] = rgb[i * 3];
          rgba[i * 4 + 1] = rgb[i * 3 + 1];
          rgba[i * 4 + 2] = rgb[i * 3 + 2];
          rgba[i * 4 + 3] = 255;
        }
        const q = quantize(rgba, planeW, planeH);
        if (this.closed || proc !== this.video) return;
        this.writer.writeFrame(baseFrame + index, paletteBytes(q.palette), q.indices);
        this.videoReady = true;
        this.mediaReady();
        index++;
        this.framesWritten = baseFrame + index;
      }
      pending = buf.subarray(off).slice();
    }
    const [code, detail] = await Promise.all([proc.exited, stderr]);
    if (!this.closed && proc === this.video) {
      if (code !== 0 || index === 0) {
        this.fail(new Error(`Video decoder failed (${code}): ${detail || "no video frames"}`));
        return;
      }
      await this.ready;
      if (this.closed || proc !== this.video) return;
      this.writer.markEnded();
      this.events.onEnd?.("video-eof");
    }
  }

  private async pumpAudio(proc: Bun.Subprocess, baseSample: number, stderr: Promise<string>): Promise<void> {
    const geo = this.writer.geo;
    const chunkSamples = geo.chunkFrames * geo.channels;
    let pending = new Uint8Array(0);
    let frames = 0;
    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) return;
    for await (const part of stdout as ReadableStream<Uint8Array>) {
      if (this.closed || proc !== this.audio) return;
      let buf = pending.length ? concat(pending, part) : part;
      while (buf.length >= chunkSamples * 2) {
        // Int16Array needs 2-byte alignment; a concat/subarray offset may
        // not be — copy the chunk out.
        const bytes = buf.slice(0, chunkSamples * 2);
        buf = buf.subarray(chunkSamples * 2);
        const pcm = new Int16Array(bytes.buffer, 0, chunkSamples);
        if (this.closed || proc !== this.audio) return;
        this.writer.writeAudio(baseSample + frames, pcm);
        this.audioReady = true;
        this.mediaReady();
        frames += geo.chunkFrames;
      }
      pending = buf.slice();
    }
    const [code, detail] = await Promise.all([proc.exited, stderr]);
    if (!this.closed && proc === this.audio && (code !== 0 || frames === 0)) {
      this.fail(new Error(`Audio decoder failed (${code}): ${detail || "no audio chunks"}`));
    }
  }

  /** Bun's Subprocess.kill silently ignores job-control signal names —
   *  stop/cont must go through process.kill(pid, …). */
  private signal(sig: "SIGSTOP" | "SIGCONT"): void {
    for (const p of [this.video, this.audio]) {
      if (!p) continue;
      try {
        process.kill(p.pid, sig);
      } catch {
        // process already exited
      }
    }
  }

  pause(): void {
    if (this.paused || this.closed || this.failed) return;
    this.paused = true;
    this.clearStartupTimer();
    this.signal("SIGSTOP"); // freeze decode+network NOW; rings stop growing
  }

  /** Resume by respawning at the paused position, NOT by SIGCONT alone:
   *  ffmpeg's -re clock keeps running while the process is stopped, so a
   *  plain continue bursts to catch up and the picture jumps by the whole
   *  pause duration (observed on hardware). The seek path already rebuilds
   *  cleanly (kill + respawn + epoch bump); reuse it. */
  resume(): void {
    if (!this.paused || this.closed) return;
    this.seek(this.framesWritten / this.fps);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Kill + respawn at `seconds`, bumping the epoch so the device resyncs. */
  seek(seconds: number): void {
    if (this.closed || this.failed) return;
    const to = Math.max(0, Math.min(seconds, Math.max(0, this.stream.durationS - 2)));
    this.killProcs();
    this.paused = false;
    this.writer.bumpEpoch();
    try {
      this.spawnAt(to);
    } catch (error) {
      this.fail(error);
    }
  }

  private killProcs(): void {
    this.clearStartupTimer();
    this.signal("SIGCONT"); // a stopped process cannot handle the TERM below
    for (const p of [this.video, this.audio]) p?.kill();
    this.video = null;
    this.audio = null;
  }

  /** Stop and close the sink (the file sink deletes its ring file — the
   *  device holds no fd into it once the app videoClose()s). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.readyResolved) this.rejectReady(new Error("Playback cancelled"));
    this.killProcs();
    this.writer.close();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
