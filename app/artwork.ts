// app/artwork.ts — row artwork as demand-driven resources.
//
// Rows never load their own pixels: a presentation declares what the
// visible window needs (createResourceView) and the framework's resource
// runtime schedules the loads inside a per-frame budget, keeps a bounded
// texture cache, and retries pending replies. Three renditions exist:
//
//   text       192×36 coverage of the title and channel (3DS bottom screen;
//              the host expands coverage natively)
//   thumbnail  72×40 sixteen-colour indexed image (3DS)
//   card       the 512×64 IMG side file with thumbnail, title, channel,
//              duration and views drawn on the Mac (PSP over USB, Vita);
//              the device loads it natively with loadImgFile
//
// The companion transport (io.offload) fetches renditions with
// youtube.artwork requests. The legacy mailbox transport (Vita) already
// names each row's card file in the search reply, so its collection
// resolves on the next frame without a request.

import { after } from "@pocketjs/framework/clock";
import { getOps } from "@pocketjs/framework/host";
import { offload, uploadCoverage, uploadIndexedImage } from "@pocketjs/framework/offload";
import type { TextureResource } from "@pocketjs/framework/resource";
import { offloadResource } from "@pocketjs/framework/resource-offload";
import { createResourceRuntime, type ResourceCollection } from "@pocketjs/framework/resource-view";
import type { ResultItem } from "./protocol.ts";

export type ArtworkInput = { videoId: string; kind: "text" | "thumbnail"; revision: string };
export type ArtworkCollection = ResourceCollection<ArtworkInput, TextureResource>;
export const rendition = (item: Pick<ResultItem, "videoId" | "title" | "channel">, kind: ArtworkInput["kind"]): ArtworkInput =>
  ({ videoId: item.videoId, kind, revision: kind === "text" ? JSON.stringify([item.title, item.channel]) : "72x40-v1" });

/** A host-rendered card: the 512-wide texture, plus the right half on a
 *  density-2 device whose card arrives as two 512×128 halves. */
export interface CardTexture extends TextureResource { right?: number }
export type CardInput = { videoId: string; card: string; cardHD?: [string, string]; revision: string };
export type CardCollection = ResourceCollection<CardInput, CardTexture>;
export const cardRendition = (item: Pick<ResultItem, "videoId" | "card" | "cardHD" | "title" | "channel">): CardInput =>
  ({ videoId: item.videoId, card: item.card, cardHD: item.cardHD, revision: JSON.stringify([item.title, item.channel]) });

function loadImg(file: string): number {
  const handle = getOps().loadImgFile?.(file) ?? -1;
  if (handle < 0) throw new Error("Card side file unavailable");
  return handle;
}

function disposeCard(value: CardTexture): void {
  getOps().freeTexture?.(value.handle);
  if (value.right !== undefined) getOps().freeTexture?.(value.right);
}

const CARD_COST = 512 * 64 + 1024;

/** The companion-backed collections: search pages and artwork share one
 *  runtime budget (two concurrent reads, one start and one upload per frame). */
export function createYoutubeResources() {
  const client = offload();
  const runtime = createResourceRuntime({ maxConcurrent: 2, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 3,
    available: () => client.connected() && client.pending() < 4 });
  const artwork = runtime.createCollection<ArtworkInput, string, TextureResource>({
    key: input => `${input.videoId}:${input.kind}:${input.revision}`,
    maxEntries: 32, maxCost: 1536 * 1024, maxResponseBytes: 5000, maxViews: 12, maxDemandsPerView: 8,
    cost: input => input.kind === "text" ? 256 * 64 * 4 : 128 * 64 * 4,
    load: offloadResource(client, "youtube.artwork", input => JSON.stringify({ videoId: input.videoId, kind: input.kind })),
    retry: { attempts: 120, delayFrames: 6, maxDelayFrames: 60 },
    materialize(raw, input) {
      const data = JSON.parse(raw);
      if (data.pending) throw new Error("Artwork pending");
      if (input.kind === "thumbnail") {
        if (data.width !== 72 || data.height !== 40) throw new Error("Invalid thumbnail dimensions");
        return uploadIndexedImage(data);
      }
      if (data.width !== 192 || data.height !== 36 || typeof data.coverage !== "string" || data.coverage.length !== 2304)
        throw new Error("Invalid title dimensions");
      const handle = uploadCoverage(data.coverage, 192, 36, 0xff332d28);
      if (handle === undefined || handle < 0) throw new Error("Title upload unavailable");
      return { handle, width: 256, height: 64 };
    },
    dispose: value => getOps().freeTexture?.(value.handle),
  });
  // Cards: the companion renders the IMG side file and answers with its
  // path; the device loads it natively — one 15 KB USB read per frame at most.
  const cards = runtime.createCollection<CardInput, string, CardTexture>({
    key: input => `${input.videoId}:card:${input.revision}`,
    // One view per mounted row: the list mounts the visible rows plus one
    // row of overscan on each side.
    maxEntries: 24, maxCost: 24 * CARD_COST, maxResponseBytes: 400, maxViews: 12, maxDemandsPerView: 2,
    cost: () => CARD_COST,
    load: offloadResource(client, "youtube.artwork", input => JSON.stringify({ videoId: input.videoId, kind: "card" })),
    retry: { attempts: 120, delayFrames: 6, maxDelayFrames: 60 },
    materialize(raw) {
      const data = JSON.parse(raw);
      if (data.pending) throw new Error("Card pending");
      if (typeof data.file !== "string" || data.width !== 512 || data.height !== 64) throw new Error("Invalid card reply");
      return { handle: loadImg(data.file), width: 512, height: 64 };
    },
    dispose: disposeCard,
  });
  return { runtime, artwork, cards };
}

/** The legacy mailbox transport (Vita over TCP, the browser dev host): the
 *  search reply already names each row's card files, so a load completes
 *  on the next virtual frame and the runtime still owns budget and cache. */
export function createLegacyCards() {
  const runtime = createResourceRuntime({ maxConcurrent: 2, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 1,
    available: () => true });
  const cards = runtime.createCollection<CardInput, string, CardTexture>({
    key: input => `${input.videoId}:card:${input.revision}`,
    maxEntries: 24, maxCost: 24 * CARD_COST * 4, maxResponseBytes: 400, maxViews: 12, maxDemandsPerView: 2,
    cost: input => input.cardHD ? CARD_COST * 4 : CARD_COST,
    load: (input, complete) => {
      const cancel = after(0, () => complete({ ok: true, value: JSON.stringify({ card: input.card, cardHD: input.cardHD }) }));
      return { cancel };
    },
    materialize(raw) {
      const data = JSON.parse(raw) as { card: string; cardHD?: [string, string] };
      if (data.cardHD) {
        const handle = loadImg(data.cardHD[0]);
        let right: number;
        try { right = loadImg(data.cardHD[1]); } catch (error) { getOps().freeTexture?.(handle); throw error; }
        return { handle, right, width: 512, height: 128 };
      }
      return { handle: loadImg(data.card), width: 512, height: 64 };
    },
    dispose: disposeCard,
  });
  return { runtime, cards };
}
