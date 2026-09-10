import { createEffect, createSignal, For, onCleanup, Show, untrack, type JSX } from "solid-js";
import { AuxiliarySurface, Focusable, Image, Text, View } from "@pocketjs/framework/components";
import { auxiliaryViewport } from "@pocketjs/framework/display";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createGesture } from "@pocketjs/framework/gesture";
import { mediaPlayer, createMediaScrubber, type MediaStatus } from "@pocketjs/framework/media";
import { offload, uploadCoverage } from "@pocketjs/framework/offload";
import { TextField, type OskController } from "@pocketjs/framework/osk";
import { VirtualList, type VirtualListHandle } from "@pocketjs/framework/virtual-list";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import type { YoutubeStore } from "./store.ts";
import type { ResultItem } from "./protocol.ts";

const BG = "#0d1117", CARD = "#1a222d", INK = "#f4f5f7", DIM = "#9aa9bb", RED = "#ff4757";
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function Tile(props: { x: number; y: number; w: number; h: number; label: string; detail?: string; accent?: boolean; onPress: () => void }) {
  return <Focusable onPress={props.onPress} class="absolute rounded-lg items-center justify-center flex-col focus:border-[#f4f5f7] active:bg-[#39485b]"
    style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h, bgColor: props.accent ? RED : CARD }}>
    <Text class="text-sm font-bold" style={{ textColor: INK }}>{props.label}</Text>
    <Show when={props.detail}><Text class="text-xs" style={{ textColor: props.accent ? INK : DIM }}>{props.detail}</Text></Show>
  </Focusable>;
}

/** Both displays share a playback lifetime. Browsing never unmounts video. */
export default function DualScreen(props: { store: YoutubeStore }) {
  const native = mediaPlayer(), top = hostViewport(getOps())!, bottom = auxiliaryViewport()!;
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
          <Image src="yt-mark.svg" style={{ width: 64, height: 44 }} />
          <Text class="text-xl font-bold" style={{ textColor: INK }}>Pocket YouTube</Text>
          <Text class="text-sm" style={{ textColor: DIM }}>Find something to watch below.</Text>
        </View>
      </Show>
      <Show when={props.store.player() && !(snapshot()?.presentedFrames)}>
        <View class="absolute inset-0 items-center justify-center">
          <Text class="text-sm" style={{ textColor: INK }}>{error() ? "PLAYBACK UNAVAILABLE" : "BUFFERING VIDEO…"}</Text>
        </View>
      </Show>
    </View>
    <AuxiliarySurface>{() => <View style={{ width: bottom.width, height: bottom.height, bgColor: BG }}>
      <Show when={panel() === "controls" && props.store.player()} fallback={<Browser store={props.store} returnToPlayer={() => setPanel("controls")} />}>
        <PlayingTitle videoId={() => props.store.player()?.videoId ?? ""} />
        <Tile x={236} y={4} w={76} h={30} label="Queue" onPress={() => setPanel("browse")} />
        <SeekCard position={position} duration={duration} seek={props.store.seekTo} status={() => props.store.status() || (snapshot()?.phase === "buffering" ? "BUFFERING" : "")} />
        <Tile x={8} y={96} w={72} h={64} label="-10" detail="seconds" onPress={() => props.store.seekTo(position() - 10)} />
        <Tile x={88} y={96} w={144} h={64} label={props.store.player()?.ended ? "Replay" : props.store.player()?.playing ? "Pause" : "Play"}
          detail={props.store.player()?.ended ? "From beginning" : "START"} accent onPress={playPause} />
        <Tile x={240} y={96} w={72} h={64} label="+10" detail="seconds" onPress={() => props.store.seekTo(position() + 10)} />
        <Tile x={8} y={168} w={72} h={48} label={volume() === 0 ? "Unmute" : "Mute"} onPress={() => changeVolume(volume() === 0 ? .8 : 0)} />
        <VolumeTile value={volume} change={changeVolume} />
        <Tile x={256} y={168} w={56} h={48} label="Stop" onPress={stop} />
        <View class="absolute" style={{ insetL: 12, insetT: 224 }}><Text class="text-xs" style={{ textColor: DIM }}>L / R  skip     B  browse</Text></View>
        <Show when={error()}>
          <View class="absolute inset-0 flex-col items-center justify-center gap-3" style={{ bgColor: BG }}>
            <Text class="text-sm" style={{ textColor: INK, width: 288 }}>{error()}</Text>
            <Focusable onPress={() => { setError(""); props.store.retryPlayback(); }} class="rounded-lg px-6 py-3 bg-[#ff4757]"><Text class="text-sm font-bold text-white">Retry</Text></Focusable>
            <Focusable onPress={stop} class="rounded-lg px-6 py-3 bg-[#1a222d]"><Text class="text-sm text-white">Back to search</Text></Focusable>
          </View>
        </Show>
      </Show>
    </View>}</AuxiliarySurface>
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
  createGesture({ surface: "auxiliary", region: { rect: () => ({ x: 8, y: 40, w: 304, h: 48 }) }, tapSlop: 9999,
    onDown: c => update(c.x, true), onMove: c => update(c.x, false),
    onUp: c => { update(c.x, false); scrubber.commit(); setPreview(null); },
    onCancel: () => { scrubber.cancel(); setPreview(null); } });
  const current = () => preview() ?? props.position();
  return <View class="absolute rounded-lg" style={{ insetL: 8, insetT: 40, width: 304, height: 48, bgColor: CARD }}>
    <View class="absolute" style={{ insetL: 12, insetT: 7 }}><Text class="text-xs" style={{ textColor: INK }}>{`${time(current())} / ${time(props.duration())}`}</Text></View>
    <View class="absolute" style={{ insetL: 130, insetT: 7 }}><Text class="text-xs" style={{ textColor: DIM }}>{props.status()}</Text></View>
    <View class="absolute rounded-sm" style={{ insetL: 12, insetT: 29, width: 280, height: 5, bgColor: "#39485b" }} />
    <View class="absolute rounded-sm" style={{ insetL: 12, insetT: 29, width: Math.max(4, 280 * Math.min(1, current() / (props.duration() || 1))), height: 5, bgColor: RED }} />
  </View>;
}

function PlayingTitle(props: { videoId: () => string }) {
  let node: NodeMirror | undefined, texture = -1, request = 0, tick = 0, loaded = "", busy = false;
  const [visible, setVisible] = createSignal(false);
  onFrame(() => {
    const id = props.videoId();
    if (busy || !id || loaded === id || ++tick % 30 || !offload().connected()) return;
    busy = true;
    request = offload().request("youtube.art", JSON.stringify({ videoId: id, strip: 0 }), result => {
      busy = false;
      if (!result.ok || props.videoId() !== id) return;
      const data = JSON.parse(result.value), handle = uploadCoverage(data.coverage, data.width, data.height, 0xffffff);
      if (handle === undefined || handle < 0) return;
      if (texture >= 0) getOps().freeTexture?.(texture);
      texture = handle; loaded = id;
      if (node) getOps().setImage(node.id, handle);
      setVisible(true);
    });
    if (!request) busy = false;
  });
  onCleanup(() => { if (request) offload().cancel(request); if (texture >= 0) getOps().freeTexture?.(texture); });
  return <View class="absolute" style={{ insetL: 12, insetT: 10, width: 212, height: 18, overflow: 1 }}>
    <Show when={!visible()}><Text class="text-xs font-bold" style={{ textColor: DIM }}>NOW PLAYING</Text></Show>
    <Image nodeRef={n => { node = n; }} class="absolute" style={{ insetL: -92, insetT: 0, width: 512, height: 16, opacity: visible() ? 1 : 0 }} />
  </View>;
}

function VolumeTile(props: { value: () => number; change: (v: number) => void }) {
  createGesture({ surface: "auxiliary", region: { rect: () => ({ x: 88, y: 168, w: 160, h: 48 }) }, tapSlop: 9999,
    onDown: c => props.change((c.x - 100) / 136), onMove: c => props.change((c.x - 100) / 136) });
  return <View class="absolute rounded-lg" style={{ insetL: 88, insetT: 168, width: 160, height: 48, bgColor: CARD }}>
    <View class="absolute" style={{ insetL: 12, insetT: 7 }}><Text class="text-xs" style={{ textColor: DIM }}>{`VOLUME  ${Math.round(props.value() * 100)}%`}</Text></View>
    <View class="absolute rounded-sm" style={{ insetL: 12, insetT: 30, width: 136, height: 5, bgColor: "#39485b" }} />
    <View class="absolute rounded-sm" style={{ insetL: 12, insetT: 30, width: Math.max(3, 136 * props.value()), height: 5, bgColor: INK }} />
  </View>;
}

function Browser(props: { store: YoutubeStore; returnToPlayer: () => void }) {
  let keyboard: OskController | undefined;
  const [list, setList] = createSignal<VirtualListHandle | null>(null);
  createEffect(() => { props.store.searchSerial(); list()?.focusRow(0); });
  onButtonPress(BTN.TRIANGLE, () => keyboard?.open());
  return <View style={{ width: 320, height: 240 }}>
    <View class="absolute" style={{ insetL: 8, insetT: 8, width: 304, height: 36 }}>
      <TextField surface="auxiliary" keyHeight={30} value={props.store.query} onInput={text => props.store.setQuery(text.slice(0, 200))} onSubmit={props.store.search}
        placeholder="Search YouTube   ·   X" ref={value => { keyboard = value; }}
        class="w-full h-[36] rounded-lg bg-[#1a222d] px-3 py-2 focus:border-[#ff4757]" />
    </View>
    <View class="absolute" style={{ insetL: 8, insetT: 52, width: 304, height: 140 }}>
      <Show when={props.store.results().length} fallback={<View class="flex-col gap-3 py-4">
        <Text class="text-sm" style={{ textColor: INK }}>{props.store.phase() === "connect" ? "CONNECTING TO COMPANION" : "Your next video starts here."}</Text>
        <Text class="text-xs" style={{ textColor: DIM }}>{props.store.status() || "Search by title, channel or topic."}</Text>
      </View>}>
        <VirtualList surface="auxiliary" count={props.store.results().length + (props.store.hasMore() ? 1 : 0)} rowHeight={68} height={140} overscan={0}
          inputActive={() => !keyboard?.isOpen()} ref={setList}
          onRowPress={index => index < props.store.results().length ? props.store.play(props.store.results()[index]) : props.store.loadMore()}
          renderRow={index => <Show when={props.store.results()[index]} fallback={<Text class="text-sm text-white">{props.store.searching() ? "Loading…" : "Load more"}</Text>}>
            <Artwork item={props.store.results()[index]} active={() => list()?.focusedIndex() === index} />
          </Show>} />
      </Show>
    </View>
    <Show when={props.store.player()} fallback={<View class="absolute" style={{ insetL: 12, insetT: 204, width: 296 }}>
      <Text class="text-xs" style={{ textColor: DIM }}>{props.store.status() || "Touch or D-pad to select · A to play"}</Text>
    </View>}>
      <Tile x={8} y={198} w={304} h={36} label="Back to playing video" onPress={props.returnToPlayer} />
    </Show>
  </View>;
}

/** Fixed-size, worker-rendered strips preserve arbitrary titles on baked-font hosts. */
function Artwork(props: { item: ResultItem; active: () => boolean }) {
  const nodes: NodeMirror[] = [], textures: number[] = [];
  let strip = 0, busy = false, disposed = false, tick = 0, request = 0;
  onFrame(() => {
    if (busy || disposed || strip >= 4 || ++tick % 12 || !offload().connected()) return;
    busy = true;
    request = offload().request("youtube.art", JSON.stringify({ videoId: props.item.videoId, strip }), result => {
      busy = false;
      if (disposed || !result.ok) return;
      const data = JSON.parse(result.value), handle = uploadCoverage(data.coverage, data.width, data.height, 0xffffff);
      if (handle === undefined || handle < 0) return;
      textures.push(handle); if (nodes[strip]) getOps().setImage(nodes[strip].id, handle); strip++;
    });
    if (!request) busy = false;
  });
  onCleanup(() => { disposed = true; if (request) offload().cancel(request); for (const handle of textures) getOps().freeTexture?.(handle); });
  return <View style={{ width: 304, height: 64, bgColor: props.active() ? "#26364b" : CARD, overflow: 1 }}>
    <For each={[0, 1, 2, 3]}>{index => <Image nodeRef={node => { nodes[index] = node; }} class="absolute" style={{ insetL: 0, insetT: index * 16, width: 512, height: 16 }} />}</For>
  </View>;
}
