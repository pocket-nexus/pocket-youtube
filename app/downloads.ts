import { createSignal, onCleanup } from "solid-js";
import { offload } from "@pocketjs/framework/offload";
import { mediaLibrary, type MediaLibraryEntry } from "@pocketjs/framework/media";
import type { ResultItem } from "./protocol.ts";

export function createDownloads() {
  const library = mediaLibrary(), client = offload();
  const [entries, setEntries] = createSignal<MediaLibraryEntry[]>([]);
  const [phase, setPhase] = createSignal("idle"), [progress, setProgress] = createSignal(0), [message, setMessage] = createSignal("");
  const [title, setTitle] = createSignal("");
  let generation = 0, job = 0, frame = 0, pending = false, transferring = false;
  const busy = () => !["idle", "complete", "cancelled", "error"].includes(phase());
  const fail = (message: string) => { setPhase("error"); setMessage(message); pending = false; transferring = false; };
  const request = (payload: object) => {
    const owner = generation; pending = true;
    const id = client.request("youtube.download", JSON.stringify(payload), result => {
      if (owner !== generation) return;
      pending = false;
      if (!result.ok) return fail(result.error);
      try {
        const state = JSON.parse(result.value); job = state.job;
        setPhase(state.phase); setProgress(state.ratio ?? 0);
        if (state.phase === "error") return fail(state.message || "Download unavailable; retry");
        if (state.phase === "ready") {
          if (!library.download(state.source, state.key)) return fail("SD worker busy; retry download");
          transferring = true; setPhase("connecting"); setProgress(0);
          setMessage(state.captions === "none" ? "Video has no captions" : state.captions ? `Captions: ${state.captions}` : "");
        }
      } catch { fail("Invalid download reply; retry"); }
    });
    if (!id) fail("Companion busy; retry download");
  };
  const start = (item: Pick<ResultItem, "videoId" | "title">, track?: string, captionsOnly = false) => {
    if (busy()) return;
    setTitle(item.title); setMessage(""); setProgress(0);
    const key = captionsOnly ? `${item.videoId}-cc-${track ?? "default"}` : item.videoId;
    if (entries().some(entry => entry.key === key)) { setPhase("complete"); setProgress(1); setMessage("Already saved on SD"); return; }
    if (!client.connected()) return fail("Connect companion to download");
    generation++; job = 0; transferring = false; setPhase("resolving");
    request({ operation: "start", videoId: item.videoId, track, captionsOnly });
  };
  const cancel = () => {
    generation++; pending = false;
    if (job && client.connected()) client.request("youtube.download", JSON.stringify({ operation: "cancel", job }), () => {});
    if (transferring) library.cancel();
    job = 0; transferring = false; setPhase("cancelled"); setMessage("Download cancelled");
  };
  onCleanup(() => { if (busy()) cancel(); });
  return {
    entries, phase, progress, message, title, busy, start, cancel,
    dismiss: () => { if (!busy()) setPhase("idle"); },
    remove: (key: string) => { if (!library.remove(key)) fail("SD worker busy; retry delete"); },
    tick() {
      if (++frame % 6) return;
      const fresh = library.entries(); if (fresh) setEntries(fresh);
      if (transferring) {
        const status = library.status(); setPhase(status.phase);
        setProgress(status.phase === "complete" ? 1 : status.totalBytes ? Math.min(.99, status.receivedBytes / status.totalBytes) : 0);
        if (status.phase === "error") fail(status.error);
        else if (status.phase === "complete" || status.phase === "cancelled") transferring = false;
      } else if (busy() && !pending && frame % 30 === 0) {
        if (!client.connected()) fail("Companion disconnected; retry download");
        else if (job) request({ operation: "status", job });
      }
    },
  };
}
export type Downloads = ReturnType<typeof createDownloads>;
