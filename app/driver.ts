import { installEffectDriver } from "@pocketjs/framework/effects";
import { createServiceClient, type ServiceTransport } from "@pocketjs/framework/service-client";
import { createMediaService } from "@pocketjs/framework/media-service";
import type { HostMsg } from "./protocol.ts";

// The application names its provider and maps domain effects to its commands.
// PocketJS owns connection, media control, clocks and asset transport.
export const youtube = createServiceClient("youtube", { httpBase: "http://127.0.0.1:8620" });
export const playback = createMediaService(youtube);
export type Transport = ServiceTransport;
export const resolveTransport = youtube.transport;
export const onHostPush = (handler: (message: HostMsg) => void) => playback.subscribe(message => handler(message as HostMsg));

export function installYoutubeDriver(): void {
  installEffectDriver((command, deliver) => {
    if (!command.kind.startsWith("yt/")) throw new Error(`Unknown YouTube effect: ${command.kind}`);
    playback.send({ t: command.kind.slice(3), id: command.id, ...(command.payload as object) }, deliver);
  });
}
