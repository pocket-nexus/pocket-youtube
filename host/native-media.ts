/** Compressed companion stream. The console owns H.264 decode, PICA upload
 * and NDSP playback; this worker owns YouTube, scaling and rate control. */
import { MEDIA } from "../vendor/pocketjs/contracts/spec/media.ts";
import { encodeMediaAudio } from "../vendor/pocketjs/contracts/spec/media-adpcm.ts";
import type { MediaPacket } from "../vendor/pocketjs/tools/media-stream.ts";
import type { ResolvedStream } from "./yt.ts";
import { ffmpegProxyArgs, proxyEnv } from "./proxy.ts";

export const NATIVE_VIDEO = { fps: 30, bitrate: 650_000, maxrate: 750_000 } as const;

/** Fit in presentation pixels, then map into the anamorphic decoder plane. */
export function nativeFit(width: number, height: number, screenW = 400, screenH = 240) {
  const ratio = (width || 16) / (height || 9), screen = screenW / screenH;
  return {
    w: Math.max(2, Math.floor(MEDIA.width * Math.min(1, ratio / screen) / 2) * 2),
    h: Math.max(2, Math.floor(MEDIA.height * Math.min(1, screen / ratio) / 2) * 2),
  };
}

/** Annex B access units begin at AUD NALs, irrespective of pipe chunking. */
export async function* accessUnits(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let buffer = Buffer.alloc(0), scan = 0, first = -1;
  for await (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    for (; scan + 4 < buffer.length; scan++) {
      if (buffer[scan] || buffer[scan + 1]) continue;
      const prefix = buffer[scan + 2] === 1 ? 3 : buffer[scan + 2] === 0 && buffer[scan + 3] === 1 ? 4 : 0;
      if (!prefix || (buffer[scan + prefix] & 31) !== 9) continue;
      if (first >= 0) {
        if (scan > MEDIA.packetBytes) throw new Error("Encoded frame exceeds decoder budget");
        yield buffer.subarray(0, scan);
        buffer = buffer.subarray(scan); scan = 0;
      }
      first = 0; scan += prefix;
    }
    if (buffer.length > MEDIA.packetBytes * 2) throw new Error("Missing bounded access unit delimiter");
  }
  if (buffer.length) {
    if (first < 0 || buffer.length > MEDIA.packetBytes) throw new Error("Incomplete encoded video");
    yield buffer;
  }
}

async function* pcmPackets(chunks: AsyncIterable<Uint8Array>, originMs: number): AsyncGenerator<MediaPacket> {
  let buffer = Buffer.alloc(0), frames = 0;
  const indices: [number, number] = [0, 0];
  for await (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= MEDIA.audioFrames * 4) {
      const bytes = buffer.subarray(0, MEDIA.audioFrames * 4);
      yield { kind: 2, ptsMs: originMs + Math.round(frames * 1000 / MEDIA.sampleRate), data: encodeMediaAudio(bytes, indices) };
      buffer = buffer.subarray(bytes.length); frames += MEDIA.audioFrames;
    }
  }
  if (buffer.length % 4) throw new Error("Truncated stereo audio");
  if (buffer.length) yield { kind: 2, ptsMs: originMs + Math.round(frames * 1000 / MEDIA.sampleRate), data: encodeMediaAudio(buffer, indices) };
}

const network = (url: string) => /^https?:\/\//.test(url) ? [
  ...ffmpegProxyArgs(), "-rw_timeout", "10000000", "-request_size", "1048576",
  "-initial_request_size", "1048576", "-short_seek_size", "1048576", "-multiple_requests", "1",
] : [];

export async function* nativeMedia(source: ResolvedStream, seconds: number, signal: AbortSignal): AsyncGenerator<MediaPacket> {
  if (signal.aborted) return;
  const originMs = Math.round(seconds * 1000), fit = nativeFit(source.width, source.height);
  const common = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror"];
  const seek = seconds > 0 ? ["-ss", String(seconds)] : [];
  const options = { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...proxyEnv() } } as const;
  // zerolatency enables sliced threading: slices=1 alone still emits one
  // slice per encoder thread. The native adapter submits one slice per frame.
  const video = Bun.spawn([...common, ...network(source.videoUrl), ...seek, "-i", source.videoUrl,
    "-an", "-vf", `fps=30,scale=${fit.w}:${fit.h}:flags=lanczos,pad=512:256:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-threads:v", "1", "-profile:v", "baseline", "-level:v", "3.0",
    "-pix_fmt", "yuv420p", "-b:v", String(NATIVE_VIDEO.bitrate), "-maxrate", String(NATIVE_VIDEO.maxrate),
    "-bufsize", "750000", "-g", "30", "-keyint_min", "30", "-bf", "0",
    "-x264-params", "aud=1:repeat-headers=1:scenecut=0:slices=1:sliced-threads=0", "-f", "h264", "pipe:1"], options);
  const audio = Bun.spawn([...common, ...network(source.audioUrl), ...seek, "-i", source.audioUrl,
    "-vn", "-ac", "2", "-ar", String(MEDIA.sampleRate), "-f", "s16le", "pipe:1"], options);
  const stop = () => { video.kill(); audio.kill(); };
  signal.addEventListener("abort", stop, { once: true });
  // Drain stderr with a fixed tail; never print signed media URLs.
  const diagnostic = async (stream: ReadableStream<Uint8Array>) => {
    let tail = "";
    for await (const chunk of stream) tail = (tail + new TextDecoder().decode(chunk)).slice(-1000);
    return tail.replace(/https?:\/\/\S+/g, "[media URL]");
  };
  const videoError = diagnostic(video.stderr), audioError = diagnostic(audio.stderr);
  async function* videoPackets(): AsyncGenerator<MediaPacket> {
    let frame = 0;
    for await (const data of accessUnits(video.stdout)) yield { kind: 1, ptsMs: originMs + Math.round(frame++ * 1000 / 30), data };
    if (await video.exited || !frame) throw new Error(`Video encoder failed: ${await videoError}`);
  }
  async function* audioPackets(): AsyncGenerator<MediaPacket> {
    let count = 0;
    for await (const packet of pcmPackets(audio.stdout, originMs)) { count++; yield packet; }
    if (await audio.exited || !count) throw new Error(`Audio encoder failed: ${await audioError}`);
  }
  const v = videoPackets(), a = audioPackets();
  try {
    let [vp, ap] = await Promise.all([v.next(), a.next()]);
    while ((!vp.done || !ap.done) && !signal.aborted) {
      if (!vp.done && (ap.done || vp.value.ptsMs <= ap.value.ptsMs)) { yield vp.value; vp = await v.next(); }
      else if (!ap.done) { yield ap.value; ap = await a.next(); }
    }
  } finally {
    stop(); signal.removeEventListener("abort", stop);
    await Promise.allSettled([video.exited, audio.exited, videoError, audioError]);
  }
}
