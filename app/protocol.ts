// YouTube commands and metadata shared with the companion.
// PocketJS service and media providers own the wire and decoder contracts.

/** Device -> host (out.jsonl / PKNT ctrl). */
import type { MediaPlaying } from "@pocketjs/framework/media-service";
export type DeviceCmd =
  /** `device` negotiates the stream profile: the host picks plane size,
   *  frame rate and audio rate per target (host/profiles.ts). Omitted (the
   *  PSP app predates it) = the tuned PSP defaults. */
  | { t: "hello"; id: number; device?: { target?: string; density?: number } }
  | { t: "search"; id: number; q: string }
  /** Next batch of the LAST search; replies `results` with only NEW items. */
  | { t: "more"; id: number }
  | { t: "play"; id: number; videoId: string; position?: number }
  | { t: "pause"; id: number }
  | { t: "resume"; id: number }
  | { t: "seek"; id: number; to: number }
  | { t: "stop"; id: number }
  /** Playback state requested by the framework media provider. */
  | { t: "status"; id: number };

export interface ResultItem {
  videoId: string;
  title: string;
  channel: string;
  durationS: number;
  views: number;
  /** Density-2 halves (two 512x128 CLUT8 IMGs drawn side by side at
   *  logical half-width — 1:1 texels on a 2x panel). Sent only to devices
   *  whose hello negotiated a density-2 profile. */
  cardHD?: [string, string];
  /** Opaque artwork reference resolved by the service image loader. */
  card: string;
}

/** Host -> PSP (in.jsonl). `id` echoes the request; hostPush events omit it. */
export type HostMsg =
  | { t: "ready"; id: number }
  | { t: "results"; id: number; items: ResultItem[] }
  | (MediaPlaying & { id: number; videoId: string; title: string; durationS: number })
  | { t: "state"; id: number; playing: boolean; position: number }
  | { t: "status"; id: number; playing: boolean; position: number; ended: boolean }
  | { t: "ended" }
  | { t: "offline" }
  | { t: "playback-error"; stream: string; message: string }
  | { t: "error"; id: number; message: string };
