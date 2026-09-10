import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type JSX } from "solid-js";
import { AuxiliarySurface, Focusable, Image, Text, View } from "@pocketjs/framework/components";
import { auxiliaryViewport } from "@pocketjs/framework/display";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createGesture } from "@pocketjs/framework/gesture";
import { mediaPlayer, createMediaScrubber, type MediaStatus } from "@pocketjs/framework/media";
import { offload } from "@pocketjs/framework/offload";
import { TextField, type OskController } from "@pocketjs/framework/osk";
import { VirtualList, type VirtualListHandle } from "@pocketjs/framework/virtual-list";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import type { YoutubeStore } from "./store.ts";
import type { ResultItem } from "./protocol.ts";
import { createResourceView } from "@pocketjs/framework/resource-view";
import { ResourceImage } from "@pocketjs/framework/resource";
import { createArtwork, rendition, type ArtworkCollection } from "./artwork.ts";

const BG = "#d9dde3", INK = "#283444", DIM = "#667485", BLUE = "#2676cb";
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function Skin(props: { src: string; w: number; h: number }) {
  return <Image src={props.src} class="absolute" style={{ insetL: 0, insetT: 0, width: props.w, height: props.h }} />;
}
function Tile(props: { x: number; y: number; w: number; h: number; label: string; icon?: string; accent?: boolean; onPress: () => void }) {
  return <Focusable onPress={props.onPress} class="absolute rounded-md overflow-hidden items-center justify-center flex-col focus:border-[#2676cb] active:opacity-70"
    style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h }}>
    <Skin src={props.h === 26 ? "classic-small-button.png" : props.w > 200 ? "classic-wide-button.png" : props.accent ? "classic-play-button.png" : "classic-button.png"}
      w={props.h === 26 ? 128 : props.w > 200 ? 512 : props.accent ? 256 : 128} h={props.h < 30 ? 32 : 64} />
    <Show when={props.icon}><Image src={props.icon!} style={{ width: 32, height: 32 }} /></Show>
    <Text class="text-xs font-bold" style={{ textColor: props.accent ? "#ffffff" : INK }}>{props.label}</Text>
  </Focusable>;
}
function Navigation(props: { title: string; children?: JSX.Element }) {
  return <View class="absolute items-center justify-center" style={{ insetL: 0, insetT: 0, width: 320, height: 36, overflow: 1 }}>
    <Skin src="classic-nav.png" w={512} h={64} />
    <View class="absolute" style={{ insetT: 11 }}><Text class="text-sm font-bold" style={{ textColor: "#ffffff" }}>{props.title}</Text></View>
    <View class="absolute" style={{ insetT: 10 }}><Text class="text-sm font-bold" style={{ textColor: "#46566c" }}>{props.title}</Text></View>
    {props.children}
  </View>;
}
/** Both displays share a playback lifetime. Browsing never unmounts video. */
export default function DualScreen(props: { store: YoutubeStore }) {
  const artwork = createArtwork();
  const native = mediaPlayer(), top = hostViewport(getOps())!, bottom = auxiliaryViewport()!;
  const playingItem = createMemo<Pick<ResultItem, "videoId" | "title" | "channel"> | undefined>(previous => {
    const player = props.store.player();
    if (!player) return undefined;
    return props.store.results().find(row => row.videoId === player.videoId)
      ?? (previous?.videoId === player.videoId ? previous : { videoId: player.videoId, title: player.title, channel: "" });
  });
  const [panel, setPanel] = createSignal<"controls" | "browse">("browse");
  const [snapshot, setSnapshot] = createSignal<MediaStatus | null>(null);
  const [volume, setVolume] = createSignal(0.8);
  const [error, setError] = createSignal("");
  let plane: NodeMirror | undefined, frame = 0, lastSerial = -1;
  createEffect(() => {
    const serial = props.store.playSerial();
    if (serial === lastSerial) return;
    lastSerial = serial;
    const player = untrack(props.store.player);
    if (!player?.source) return;
    setError(""); setSnapshot(null); setPanel("controls");
    if (!native.open(player.source)) setError("PLAYER BUSY — TAP RETRY");
    native.volume(volume());
    if (plane) getOps().setImage(plane.id, native.texture());
  });
  onFrame(() => {
    if (++frame % 6) return;
    const status = native.status(); setSnapshot(status);
    if (status.phase === "error") setError(status.error);
    const p = props.store.player();
    if (p && status.phase !== "opening" && status.phase !== "idle" && status.phase !== "error")
      props.store.reportPlayback(status.positionMs / 1000, status.phase === "ended");
    if (frame % 120 === 0 && p && offload().connected())
      offload().request("youtube.metrics", JSON.stringify(status), () => {});
  });
  onCleanup(() => native.close());
  const changeVolume = (value: number) => { setVolume(Math.max(0, Math.min(1, value))); native.volume(volume()); };
  const playPause = () => props.store.player()?.ended ? props.store.seekTo(0) : props.store.togglePause();
  const stop = () => { native.close(); props.store.stopPlayback(); setPanel("browse"); setError(""); };
  onButtonPress(BTN.START, playPause);
  onButtonPress(BTN.LTRIGGER, () => props.store.seekTo((props.store.player()?.position ?? 0) - 10));
  onButtonPress(BTN.RTRIGGER, () => props.store.seekTo((props.store.player()?.position ?? 0) + 10));
  onButtonPress(BTN.CROSS, () => panel() === "browse" && props.store.player() ? setPanel("controls") : setPanel("browse"));
  const position = () => props.store.player()?.position ?? 0;
  const duration = () => props.store.player()?.durationS ?? 0;
  return <>
    <View style={{ width: top.w, height: top.h, bgColor: "#000000" }}>
      <Image nodeRef={n => { plane = n; getOps().setImage(n.id, native.texture()); }}
        style={{ width: top.w, height: top.h, opacity: props.store.player() && (snapshot()?.presentedFrames ?? 0) > 0 ? 1 : 0 }} />
      <Show when={!props.store.player()}>
        <View class="absolute inset-0 items-center justify-center flex-col gap-3">
          <View style={{ width: 220, height: 49, overflow: 1 }}><Skin src="yt-logo-white.png" w={256} h={64} /></View>
          <Text class="text-sm" style={{ textColor: "#abb3bd" }}>Find something to watch below.</Text>
        </View>
      </Show>
      <Show when={props.store.player() && !(snapshot()?.presentedFrames)}>
        <View class="absolute inset-0 items-center justify-center">
          <Text class="text-sm" style={{ textColor: "#ffffff" }}>{error() ? "PLAYBACK UNAVAILABLE" : "BUFFERING VIDEO…"}</Text>
        </View>
      </Show>
    </View>
    <AuxiliarySurface>{() => <View style={{ width: bottom.width, height: bottom.height, bgColor: BG }}>
      <Skin src="classic-linen.png" w={512} h={256} />
      <Show when={panel() === "controls" && props.store.player()} fallback={<Browser store={props.store} artwork={artwork} returnToPlayer={() => setPanel("controls")} />}>
        <Navigation title="Now Playing"><Tile x={244} y={5} w={68} h={26} label="Videos" onPress={() => setPanel("browse")} /></Navigation>
        <View class="absolute" style={{ insetL: 0, insetT: 36, width: 320, height: 48 }}><Artwork item={playingItem()!} artwork={artwork} compact /></View>
        <SeekCard position={position} duration={duration} seek={props.store.seekTo} status={() => props.store.status() || (snapshot()?.phase === "buffering" ? "Buffering…" : "")} />
        <Tile x={8} y={124} w={72} h={56} label="10 sec" icon="classic-back.png" onPress={() => props.store.seekTo(position() - 10)} />
        <Tile x={88} y={124} w={144} h={56} label={props.store.player()?.ended ? "Replay" : props.store.player()?.playing ? "Pause" : "Play"}
          icon={props.store.player()?.playing ? "classic-pause.png" : "classic-play.png"} accent onPress={playPause} />
        <Tile x={240} y={124} w={72} h={56} label="10 sec" icon="classic-next.png" onPress={() => props.store.seekTo(position() + 10)} />
        <Focusable onPress={() => changeVolume(volume() === 0 ? .8 : 0)} class="absolute" style={{ insetL: 8, insetT: 189, width: 36, height: 34 }}>
          <Image src="classic-speaker.png" style={{ width: 32, height: 32, opacity: volume() === 0 ? .4 : 1 }} />
        </Focusable>
        <VolumeTile value={volume} change={changeVolume} />
        <Tile x={244} y={196} w={68} h={26} label="Stop" onPress={stop} />
        <View class="absolute" style={{ insetL: 77, insetT: 227 }}><Text class="text-xs" style={{ textColor: DIM }}>L / R skip     B browse</Text></View>
        <Show when={error()}>
          <View class="absolute inset-0 flex-col items-center justify-center gap-3" style={{ bgColor: BG }}>
            <Text class="text-sm" style={{ textColor: INK, width: 288 }}>{error()}</Text>
            <Focusable onPress={() => { setError(""); props.store.retryPlayback(); }} class="rounded-lg px-6 py-3 bg-[#2676cb]"><Text class="text-sm font-bold text-white">Retry</Text></Focusable>
            <Focusable onPress={stop} class="rounded-lg px-6 py-3 bg-[#667485]"><Text class="text-sm text-white">Back to search</Text></Focusable>
          </View>
        </Show>
      </Show>
    </View>}</AuxiliarySurface>
  </>;
}

function Rail(props: { width: number; ratio: number }) {
  const fill = () => Math.max(0, Math.min(1, props.ratio)) * props.width;
  return <>
    <View class="absolute rounded-sm" style={{ insetT: 4, width: props.width, height: 6, bgColor: "#ffffff" }} />
    <View class="absolute rounded-sm" style={{ insetT: 3, width: props.width, height: 5, bgColor: "#929da9" }} />
    <View class="absolute rounded-sm" style={{ insetT: 3, width: Math.max(2, fill()), height: 5, bgColor: BLUE }} />
    <View class="absolute rounded-full w-[12] h-[12]" style={{ insetL: fill() - 6, width: 12, height: 12, bgColor: "#f8fafc", borderWidth: 1, borderColor: "#8997a6" }} />
  </>;
}
function SeekCard(props: { position: () => number; duration: () => number; seek: (s: number) => void; status: () => string }) {
  const scrubber = createMediaScrubber(props.seek);
  const [preview, setPreview] = createSignal<number | null>(null);
  const update = (x: number, begin: boolean) => {
    if (begin) scrubber.begin((x - 20) / 280, props.duration());
    else scrubber.move((x - 20) / 280, props.duration());
    setPreview(scrubber.preview());
  };
  createGesture({ surface: "auxiliary", region: { rect: () => ({ x: 8, y: 86, w: 304, h: 32 }) }, tapSlop: 9999,
    onDown: c => update(c.x, true), onMove: c => update(c.x, false),
    onUp: c => { update(c.x, false); scrubber.commit(); setPreview(null); },
    onCancel: () => { scrubber.cancel(); setPreview(null); } });
  const current = () => preview() ?? props.position();
  return <View class="absolute" style={{ insetL: 20, insetT: 86, width: 280, height: 32 }}>
    <View class="absolute"><Text class="text-xs" style={{ textColor: DIM }}>{time(current())}</Text></View>
    <View class="absolute" style={{ insetR: 0 }}><Text class="text-xs" style={{ textColor: DIM }}>{time(props.duration())}</Text></View>
    <View class="absolute items-center" style={{ width: 280 }}><Text class="text-xs" style={{ textColor: DIM }}>{props.status()}</Text></View>
    <View class="absolute" style={{ insetT: 18 }}><Rail width={280} ratio={current() / (props.duration() || 1)} /></View>
  </View>;
}
function VolumeTile(props: { value: () => number; change: (v: number) => void }) {
  createGesture({ surface: "auxiliary", region: { rect: () => ({ x: 44, y: 190, w: 190, h: 34 }) }, tapSlop: 9999,
    onDown: c => props.change((c.x - 52) / 170), onMove: c => props.change((c.x - 52) / 170) });
  return <View class="absolute" style={{ insetL: 52, insetT: 204 }}><Rail width={170} ratio={props.value()} /></View>;
}
function Browser(props: { store: YoutubeStore; artwork: ArtworkCollection; returnToPlayer: () => void }) {
  let keyboard: OskController | undefined;
  const [list, setList] = createSignal<VirtualListHandle | null>(null);
  createEffect(() => { props.store.searchSerial(); list()?.focusRow(0); });
  onButtonPress(BTN.TRIANGLE, () => keyboard?.open());
  createResourceView(props.artwork, { demand: () => {
    const first = Math.floor((list()?.scroller.offset() ?? 0) / 64);
    return props.store.results().slice(first + 2, first + 5).flatMap(item => [
      { input: rendition(item, "text"), priority: 20 }, { input: rendition(item, "thumbnail"), priority: 30 },
    ]);
  } });
  return <View style={{ width: 320, height: 240 }}>
    <Navigation title="Videos" />
    <View class="absolute" style={{ insetL: 8, insetT: 40, width: 304, height: 28 }}>
      <TextField surface="auxiliary" theme="light" keyHeight={30} value={props.store.query} onInput={text => props.store.setQuery(text.slice(0, 200))} onSubmit={props.store.search}
        placeholder="Search YouTube" ref={value => { keyboard = value; }}
        class="w-full h-[28] rounded-lg bg-white px-3 py-1 border border-[#9aa5b2] focus:border-[#2676cb]" />
    </View>
    <View class="absolute" style={{ insetL: 0, insetT: 74, width: 320, height: 138 }}>
      <Show when={props.store.results().length} fallback={<View class="flex-col items-center gap-3 py-5">
        <Text class="text-sm font-bold" style={{ textColor: INK }}>{props.store.phase() === "connect" ? "Connecting…" : "Find your next video"}</Text>
        <Text class="text-xs" style={{ textColor: DIM }}>{props.store.status() || "Search by title, channel or topic."}</Text>
      </View>}>
        <VirtualList surface="auxiliary" count={props.store.results().length + (props.store.hasMore() ? 1 : 0)} rowHeight={64} height={138} overscan={0}
          inputActive={() => !keyboard?.isOpen()} ref={setList}
          onRowPress={index => index < props.store.results().length ? props.store.play(props.store.results()[index]) : props.store.loadMore()}
          renderRow={index => <Show when={props.store.results()[index]} fallback={<View class="items-center py-4"><Text class="text-sm" style={{ textColor: DIM }}>{props.store.searching() ? "Loading…" : "Load more videos"}</Text></View>}>
            <Artwork item={props.store.results()[index]} artwork={props.artwork} active={() => list()?.focusedIndex() === index} />
          </Show>} />
      </Show>
    </View>
    <View class="absolute items-center justify-center" style={{ insetL: 0, insetT: 212, width: 320, height: 28, overflow: 1 }}>
      <Skin src="classic-footer.png" w={512} h={32} />
      <Show when={props.store.player()} fallback={<Text class="text-xs" style={{ textColor: DIM }}>{props.store.status() || "Touch to play  ·  X to search"}</Text>}>
        <Focusable onPress={props.returnToPlayer} class="w-full h-full items-center justify-center active:opacity-70"><Text class="text-xs font-bold" style={{ textColor: INK }}>Now Playing  ▸</Text></Focusable>
      </Show>
    </View>
  </View>;
}
function Artwork(props: { item: Pick<ResultItem, "videoId" | "title" | "channel"> & Partial<ResultItem>; artwork: ArtworkCollection; active?: () => boolean; compact?: boolean }) {
  const text = () => rendition(props.item, "text"), thumbnail = () => rendition(props.item, "thumbnail");
  const view = createResourceView(props.artwork, { demand: () => [
    { input: text(), priority: 0, pin: true }, { input: thumbnail(), priority: 10, pin: true },
  ] });
  return <View style={{ width: 320, height: props.compact ? 48 : 64, overflow: 1 }}>
    <Show when={!props.compact}><Skin src={props.active?.() ? "classic-row-selected.png" : "classic-row.png"} w={512} h={64} /></Show>
    <ResourceImage state={() => view.state(thumbnail())} class="absolute" style={{ insetL: 10, insetT: props.compact ? 4 : 8, width: 72, height: 40, overflow: 1 }}
      fallback={() => <View class="items-center justify-center" style={{ width: 72, height: 40, bgColor: "#b0b9c5" }}><Image src="classic-play.png" style={{ width: 24, height: 24, opacity: .7 }} /></View>} />
    <ResourceImage state={() => view.state(text())} class="absolute" style={{ insetL: 92, insetT: props.compact ? 4 : 7, width: 192, height: 36, overflow: 1 }}
      fallback={() => <View class="flex-col gap-1" style={{ width: 192, height: 36, paddingT: 3 }}>
        <For each={[180, 138, 80]}>{width => <View style={{ width, height: 6, bgColor: "#d0d7df" }} />}</For>
      </View>} />
    <Show when={!props.compact}>
      <View class="absolute" style={{ insetL: 10, insetT: 49 }}><Text class="text-xs" style={{ textColor: DIM }}>{time(props.item.durationS ?? 0)}</Text></View>
      <View class="absolute" style={{ insetL: 92, insetT: 47 }}><Text class="text-xs" style={{ textColor: DIM }}>{`${(props.item.views ?? 0) >= 1000 ? `${Math.floor((props.item.views ?? 0) / 1000)}K` : props.item.views ?? 0} views`}</Text></View>
      <Image src="classic-chevron.png" class="absolute" style={{ insetL: 296, insetT: 18, width: 24, height: 24 }} />
    </Show>
  </View>;
}
