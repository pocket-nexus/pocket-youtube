import { createResourceRuntime, type ResourceCollection } from "@pocketjs/framework/resource-view";
import { offloadResource } from "@pocketjs/framework/resource-offload";
import { offload, uploadCoverage, uploadIndexedImage } from "@pocketjs/framework/offload";
import { getOps } from "@pocketjs/framework/host";
import type { TextureResource } from "@pocketjs/framework/resource";
import type { ResultItem } from "./protocol.ts";
export type ArtworkInput = { videoId: string; kind: "text" | "thumbnail"; revision: string };
export type ArtworkCollection = ResourceCollection<ArtworkInput, TextureResource>;
export const rendition = (item: Pick<ResultItem, "videoId" | "title" | "channel">, kind: ArtworkInput["kind"]): ArtworkInput =>
  ({ videoId: item.videoId, kind, revision: kind === "text" ? JSON.stringify([item.title, item.channel]) : "72x40-v1" });

export function createYoutubeResources() {
  const client = offload();
  const runtime = createResourceRuntime({ maxConcurrent: 2, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 2,
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
  return { runtime, artwork };
}
