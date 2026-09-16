// demos/youtube/store.ts — Pocket YouTube's state machine.
//
// Three phases: "connect" (no transport yet — the Mac service is not
// running or the USB cable is out), "browse" (search + results) and
// "player" (a stream is up). Every transition is a delivery from the effect
// shell (driver.ts) or a button edge — no timers, no promises, the
// determinism rules the rest of the repo lives by.

import { createSignal } from "solid-js";
import { runEffect } from "@pocketjs/framework/effects";
import { virtualFrame } from "@pocketjs/framework/clock";
import { onHostPush, resolveTransport, playback, type Transport } from "./driver.ts";
import type { HostMsg, ResultItem } from "./protocol.ts";
import type { SearchModel } from "./search.ts";

export interface PlayerState {
  videoId: string;
  title: string;
  durationS: number;
  fps: number;
  position: number;
  playing: boolean;
  /** True once the host reported the source exhausted. */
  ended: boolean;
}

export type Phase = "connect" | "browse" | "player";

export function createYoutubeStore(browse?: SearchModel) {
  const [phase, setPhase] = createSignal<Phase>("connect");
  const [transport, setTransport] = createSignal<Transport>("none");
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<ResultItem[]>([]);
  const [searching, setSearching] = createSignal(false);
  /** The last fetch returned rows — a LOAD MORE row is worth offering. */
  const [hasMore, setHasMore] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [player, setPlayer] = createSignal<PlayerState | null>(null);
  /** Bumped on every "playing" reply — the player screen re-opens the
   *  stream when it changes (fresh .pkst file per play/replay). */
  const [playSerial, setPlaySerial] = createSignal(0);
  const [playReason, setPlayReason] = createSignal<"play" | "seek" | "resume">("play");
  /** Bumped when a FRESH search replaces the list (appends do not) — the
   *  browse screen focuses row 0 so ○ plays the first result immediately. */
  const [searchSerial, setSearchSerial] = createSignal(0);
  let lastHello = -1;
  let playbackGeneration = 0;

  onHostPush((msg: HostMsg) => {
    if (msg.t === "offline") { setStatus("Companion disconnected. Reconnecting…"); setPhase("connect"); }
    if (msg.t === "playback-error") {
      setPlayer(null);
      setPhase("browse");
      setStatus(`Error: ${msg.message}`);
    }
    if (msg.t === "ended") {
      const p = player();
      if (p) setPlayer({ ...p, ended: true, playing: false });
    }
  });

  const hello = (): void => {
    lastHello = virtualFrame();
    runEffect<HostMsg>("yt/hello", {}, (msg) => {
      if (msg.t === "ready") {
        setTransport(resolveTransport()); setStatus("");
        if (phase() === "connect") {
          const p = player();
          setPhase("browse");
          if (p) startPlayback(p.videoId, p.position, "resume");
        }
      }
    });
  };

  /** connect-phase retry pump (driven by the app's onFrame): re-probe the
   *  transport every ~2 s until the host answers. */
  const connectTick = (): void => {
    if (phase() !== "connect" && resolveTransport() !== "none") return;
    const now = virtualFrame();
    if (lastHello < 0 || now - lastHello >= 120) hello();
  };

  const search = (): void => {
    const q = query().trim();
    if (!q || searching()) return;
    setSearching(true);
    setStatus("Searching…");
    runEffect<HostMsg>("yt/search", { q }, (msg) => {
      setSearching(false);
      if (msg.t === "results") {
        setResults(msg.items);
        setHasMore(msg.items.length > 0);
        if (msg.items.length > 0) setSearchSerial(searchSerial() + 1);
        setStatus(msg.items.length === 0 ? "No results" : "");
      } else if (msg.t === "error") {
        setStatus(msg.message === "offline" ? "Host offline" : `Error: ${msg.message}`);
        if (msg.message === "offline") setPhase("connect");
      }
    });
  };

  /** Fetch the next page of the current search; new rows append in place
   *  (the LOAD MORE sentinel stays focused, now above the fresh rows). */
  const loadMore = (): void => {
    if (searching() || !hasMore()) return;
    setSearching(true);
    setStatus("Loading more…");
    runEffect<HostMsg>("yt/more", {}, (msg) => {
      setSearching(false);
      if (msg.t === "results") {
        setHasMore(msg.items.length > 0);
        setResults([...results(), ...msg.items]);
        // End of results: the sentinel row vanishes; the VirtualList's
        // focus repair pulls the focused index back onto the last real row.
        setStatus("");
      } else if (msg.t === "error") {
        setStatus(`Error: ${msg.message}`);
      }
    });
  };

  /** Touch made accidental double-activation easy (two spawned host
   *  pipelines observed on hardware) — one play request in flight at a time;
   *  taps while resolving are absorbed. */
  let playPending = false;
  const startPlayback = (videoId: string, position = 0, reason: "play" | "resume" = "play"): boolean => {
    if (playPending) return false;
    playPending = true;
    const owner = ++playbackGeneration;
    setStatus("Resolving…");
    runEffect<HostMsg>("yt/play", { videoId, position }, (msg) => {
      if (owner !== playbackGeneration) return;
      playPending = false;
      if (msg.t === "playing") {
        setStatus("");
        setPlayer({
          videoId: msg.videoId,
          title: msg.title,
          durationS: msg.durationS,
          fps: msg.fps,
          position: msg.position,
          playing: true,
          ended: false,
        });
        setPlayReason(reason); setPlaySerial(playSerial() + 1);
        setPhase("player");
      } else if (msg.t === "error") {
        setStatus(`Error: ${msg.message}`);
      }
    });
    return true;
  };
  const play = (item: ResultItem): void => { startPlayback(item.videoId); };

  const togglePause = (): void => {
    const p = player();
    if (!p || p.ended) return;
    const kind = p.playing ? "yt/pause" : "yt/resume";
    setPlayer({ ...p, playing: !p.playing });
    runEffect<HostMsg>(kind, {}, msg => {
      if (msg.t === "error") { setPlayer(p); setStatus(`Error: ${msg.message}`); }
    });
  };

  /** Absolute seek; the host clamps to the source range. */
  const seekTo = (seconds: number): void => {
    const p = player();
    if (!p || playPending) return;
    const owner = ++playbackGeneration;
    playPending = true; setStatus("Seeking…");
    setPlayer({ ...p, playing: true, ended: false });
    runEffect<HostMsg>("yt/seek", { to: Math.max(0, seconds) }, msg => {
      if (owner !== playbackGeneration) return;
      playPending = false;
      if (msg.t === "playing") {
        setPlayer({ ...p, position: msg.position, playing: true, ended: false });
        setPlayReason("seek"); setPlaySerial(playSerial() + 1); setStatus("");
      } else if (msg.t === "state") {
        setPlayer({ ...p, position: msg.position, playing: msg.playing, ended: false }); setStatus("");
      } else if (msg.t === "error") { setPlayer(p); setStatus(`Error: ${msg.message}`); }
    });
  };

  const stopPlayback = (): void => {
    playbackGeneration++; playPending = false;
    setPlayer(null);
    setPhase("browse");
    runEffect<HostMsg>("yt/stop", {}, () => {});
  };

  const reportPlayback = (position: number, ended: boolean): void => {
    const p = player();
    if (p) setPlayer({ ...p, position, ended, playing: ended ? false : p.playing });
  };

  return {
    playback, playReason,
    phase,
    transport,
    query,
    setQuery,
    results,
    searching,
    hasMore,
    status,
    player,
    playSerial,
    searchSerial,
    connectTick,
    hello,
    search,
    loadMore,
    play,
    togglePause,
    seekTo,
    stopPlayback,
    reportPlayback,
    prefetch: (first: number, visible: number, velocity: number) => browse?.prefetch(first, visible, velocity),
    ...(browse ? { query: browse.query, setQuery: browse.setQuery, results: browse.results, searching: browse.searching,
      hasMore: browse.hasMore, searchSerial: browse.searchSerial, status: () => status() || browse.status(),
      search: () => { setStatus(""); browse.search(); }, loadMore: browse.loadMore } : {}),
    retryPlayback: () => { const p = player(); if (p) startPlayback(p.videoId, p.position); },
  };
}

export type YoutubeStore = ReturnType<typeof createYoutubeStore>;
