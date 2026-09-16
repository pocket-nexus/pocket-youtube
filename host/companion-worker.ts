import { dispatchOffload } from "../vendor/pocketjs/tools/offload-provider.ts";
import { createMediaStreamServer, mediaHeader, type MediaPacket } from "../vendor/pocketjs/tools/media-stream.ts";
import type { MediaSource } from "../vendor/pocketjs/contracts/spec/media.ts";
import { search, resolve, type ResolvedStream, type SearchItem } from "./yt.ts";
import { nativeMedia } from "./native-media.ts";
import { PlaySession } from "./media.ts";
import { PSP_PROFILE } from "./profiles.ts";
import { FileRingSink } from "./sink.ts";
import { existsSync, mkdirSync } from "node:fs";

import { createSearchPages } from "./search-pages.ts";
import { createClassicArt } from "./classic-art.ts";
const classicArt = createClassicArt();

type Job = { state: "pending" } | { state: "done"; value: unknown } | { state: "error"; message: string };
const jobs = new Map<number, Job>();
const items = new Map<string, SearchItem>();
const searchPages = createSearchPages(undefined, row => {
  items.set(row.videoId, row);
  if (items.size > 201) {
    const expired = [...items.keys()].find(id => id !== resolved?.videoId);
    if (expired) items.delete(expired);
  }
});
let nextJob = 1, query = "", page = 0, generation = 0;
let resolved: ResolvedStream | undefined, active: MediaSource | undefined;
let server: Awaited<ReturnType<typeof createMediaStreamServer>>;
let init: Promise<void>;
/** USB mode: the host0 share the PSP mounts; side files land under it. */
let svcDir: string | undefined;
/** The PSP's ring session and its side-file path (`media/play-N.pkst`). */
let ring: PlaySession | null = null, ringPath = "", ringSerial = 0, ringEnded = false;
const RETRYABLE_MEDIA_RING = /timed out|Connection (refused|reset)|Network is unreachable|Input\/output error/i;

function ringGeometry(durationS: number) {
  return { ...PSP_PROFILE.geometry, totalFrames: Math.max(0, Math.round(durationS * PSP_PROFILE.fps)) };
}
/** The PSP path: resolve, stream into a ring file under the svc dir, and
 *  hand the device the ring's svc-relative path for videoOpen. A stall
 *  before the first frame re-resolves onto a fresh node, like the TCP path. */
async function playRing(videoId: string, seconds: number) {
  ring?.close(); ring = null; ringEnded = false;
  let stream = resolved?.videoId === videoId ? resolved : await resolve(videoId);
  resolved = stream;
  for (let attempt = 0; ; attempt++) {
    ringPath = `media/play-${++ringSerial}.pkst`;
    const session = new PlaySession(stream, new FileRingSink(svcDir!, ringPath, ringGeometry(stream.durationS)), {
      onEnd: () => { if (ring === session) ringEnded = true; },
      onError: (message) => { console.error(`playback failed: ${message}`); if (ring === session) { ring = null; ringEnded = true; } },
    });
    ring = session;
    try {
      if (seconds > 0) session.seek(seconds);
      await session.ready;
      break;
    } catch (error) {
      session.close(); if (ring === session) ring = null;
      if (attempt >= 2 || !RETRYABLE_MEDIA_RING.test(String(error))) throw error;
      console.error(`  attempt ${attempt + 1} stalled before the first frame; re-resolving`);
      stream = await resolve(videoId); resolved = stream;
    }
  }
  items.set(videoId, { videoId, title: stream.title, channel: stream.channel, durationS: stream.durationS, views: items.get(videoId)?.views ?? 0 });
  return { t: "playing", videoId, title: stream.title.slice(0, 160), durationS: stream.durationS, fps: PSP_PROFILE.fps,
    stream: ringPath, position: ring?.positionBase ?? seconds };
}
function stop() { generation++; if (active) server.revoke(active); active = undefined; }
function job(work: () => Promise<unknown>) {
  if (jobs.size >= 4) throw new Error("Companion busy");
  const id = nextJob++;
  jobs.set(id, { state: "pending" });
  setTimeout(() => jobs.delete(id), 90000).unref();
  void work().then(value => { if (jobs.has(id)) jobs.set(id, { state: "done", value }); }, error => {
    console.error(String(error).replace(/https?:\/\/\S+/g, "[media URL]"));
    if (jobs.has(id)) jobs.set(id, { state: "error", message: "Source unavailable; retry playback or search" });
  });
  return { job: id };
}
/** A googlevideo edge node the resolver hands out can stall the first
 *  request through the Mac's network path while the next node answers at
 *  once; a stream that dies before its first packet with a timeout is
 *  re-resolved (fresh URLs, a fresh node) up to twice before it fails. */
const RETRYABLE_MEDIA = /timed out|Connection (refused|reset)|Network is unreachable|Input\/output error/i;
async function* retryingMedia(source: ResolvedStream, seconds: number, signal: AbortSignal, reresolve: () => Promise<ResolvedStream>): AsyncGenerator<MediaPacket> {
  for (let attempt = 0; ; attempt++) {
    let yielded = false;
    try {
      for await (const packet of nativeMedia(source, seconds, signal)) { yielded = true; yield packet; }
      return;
    } catch (error) {
      if (yielded || attempt >= 2 || signal.aborted || !RETRYABLE_MEDIA.test(String(error))) throw error;
      console.error(`media: attempt ${attempt + 1} stalled before the first packet; re-resolving ${source.videoId}`);
      source = await reresolve();
      if (signal.aborted) return;
    }
  }
}
async function play(videoId: string, position: number) {
  stop(); const owner = generation;
  const source = resolved?.videoId === videoId ? resolved : await resolve(videoId);
  if (owner !== generation) throw new Error("Playback superseded");
  resolved = source;
  items.set(videoId, { videoId, title: source.title, channel: source.channel, durationS: source.durationS, views: items.get(videoId)?.views ?? 0 });
  const seconds = Math.max(0, Math.min(Number.isFinite(position) ? position : 0, Math.max(0, source.durationS - 1)));
  active = server.publish(mediaHeader(Math.round(seconds * 1000), source.durationS * 1000),
    signal => retryingMedia(source, seconds, signal, async () => { resolved = await resolve(videoId); return resolved; }));
  return { t: "playing", videoId, title: source.title.slice(0, 160), durationS: source.durationS,
    fps: 30, stream: active.token, source: active, position: seconds };
}
async function results(q: string, count: number) {
  const found = await search(q, count * 5);
  const rows = found.slice((count - 1) * 5, count * 5);
  for (const row of rows) items.set(row.videoId, row);
  return { t: "results", items: rows.map(row => ({ ...row, title: row.title.slice(0, 100), channel: row.channel.slice(0, 48), card: row.videoId })) };
}
const methods = {
  "youtube.command": async (raw: string) => {
    await init;
    const cmd = JSON.parse(raw);
    let result: unknown;
    switch (cmd.t) {
      case "hello": result = { t: "ready" }; break;
      case "status":
        result = svcDir
          ? { t: "status", playing: !!ring && !ringEnded, position: ring?.positionBase ?? 0, ended: ringEnded }
          : { t: "status", playing: !!active, position: 0, ended: false };
        break;
      case "pause": ring?.pause(); result = { t: "state", playing: false, position: ring?.positionBase ?? 0 }; break;
      case "resume": ring?.resume(); result = { t: "state", playing: !!ring, position: ring?.positionBase ?? 0 }; break;
      case "search": {
        if (typeof cmd.q !== "string" || !cmd.q.trim() || cmd.q.length > 200) throw new Error("Invalid search");
        const playingItem = resolved ? items.get(resolved.videoId) : undefined;
        query = cmd.q; page = 1; items.clear();
        if (playingItem) items.set(playingItem.videoId, playingItem);
        const q = query; result = job(() => results(q, 1)); break;
      }
      case "more": {
        if (!query || page >= 20) { result = { t: "results", items: [] }; break; }
        const q = query, next = ++page; result = job(() => results(q, next)); break;
      }
      case "play":
        if (typeof cmd.videoId !== "string" || !/^[\w-]{11}$/.test(cmd.videoId)) throw new Error("Invalid video");
        result = job(() => svcDir ? playRing(cmd.videoId, Number(cmd.position ?? 0)) : play(cmd.videoId, Number(cmd.position ?? 0))); break;
      case "seek":
        if (!resolved || !Number.isFinite(cmd.to)) throw new Error("No active video");
        if (svcDir) {
          if (ring) { ring.seek(Math.max(0, cmd.to)); ringEnded = false; result = { t: "state", playing: true, position: ring.positionBase }; }
          else result = job(() => playRing(resolved!.videoId, Math.max(0, cmd.to)));
          break;
        }
        result = job(() => play(resolved!.videoId, cmd.to)); break;
      case "stop": stop(); ring?.close(); ring = null; ringEnded = false; result = { t: "state", playing: false, position: 0 }; break;
      default: throw new Error("Unsupported command");
    }
    return JSON.stringify(result);
  },
  "youtube.poll": (raw: string) => {
    const id = JSON.parse(raw).job, result = jobs.get(id);
    if (!result) throw new Error("Expired operation");
    if (result.state !== "pending") jobs.delete(id);
    return JSON.stringify(result);
  },
  "youtube.search": (raw: string) => {
    const { query, offset } = JSON.parse(raw);
    return JSON.stringify(searchPages.page(query, offset));
  },
  "youtube.artwork": async (raw: string) => {
    const data = JSON.parse(raw), item = items.get(data.videoId);
    if (!item) throw new Error("Unknown result");
    if (data.kind === "text") return JSON.stringify(await classicArt.text(item, Number.isInteger(data.width) ? data.width : 192));
    if (data.kind === "thumbnail") return JSON.stringify(classicArt.thumbnail(data.videoId));
    throw new Error("Unknown artwork rendition");
  },
  "youtube.metrics": (raw: string) => { console.log(`Playback ${raw}`); return "{}"; },
};

self.onmessage = event => {
  if (event.data.init) {
    if (typeof event.data.init.directory === "string") {
      // USB mode (PSP): no media servers; side files under the host0 share.
      svcDir = `${event.data.init.directory}/pocket-svc/youtube`;
      for (const sub of ["thumbs", "media"]) if (!existsSync(`${svcDir}/${sub}`)) mkdirSync(`${svcDir}/${sub}`, { recursive: true });
      init = Promise.resolve();
    } else {
      init = createMediaStreamServer({ advertiseHost: event.data.init.advertiseHost, log: console.error }).then(stream => { server = stream; });
    }
    // The USB provider waits for this before it publishes its heartbeat.
    void init.then(() => self.postMessage({ ready: true }));
    return;
  }
  void dispatchOffload(methods, event.data).then(reply => self.postMessage(reply));
};
