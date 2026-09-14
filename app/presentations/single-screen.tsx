// app/presentations/single-screen.tsx — Pocket YouTube on one 480×272
// screen: the PSP over USB, the Vita over WiFi.
//
// No WiFi anywhere in the PSP design: a companion Mac service
// (host/serve.ts) owns the network and the pixels, and everything reaches
// the device through the PSPLINK usbhostfs share — search results as
// host-rendered full-width row images (CJK titles included; the PSP atlas
// never could), the video itself as a CLUT8+PCM ring stream on the native
// video plane.
//
// The look is the classic light chrome the dual-screen presentation wears
// on the 3DS: linen background, glossy bars, white rows with a blue
// selection wash, and the framework's classic keyboard. Text entry rides
// the SYSTEM keyboard (@pocketjs/framework/osk): △ opens it, and while it
// is up every handler below is muted by the framework's modal block.
// START/✓ commits the search. The keyboard follows this surface's
// modality — the d-pad grid on a PSP, the phone layout on a Vita panel.
//
// The results column is the framework VirtualList: one component, layered
// input — touch pan/fling + tap-to-play where the host delivers contacts
// (Vita), the d-pad focus walk everywhere (PSP unchanged), hover-focus
// under the virtual cursor. Only the visible slice mounts.

import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { CLASSIC } from "@pocketjs/framework/classic";
import { createSpriteAnimation, onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework/host";
import { glyph } from "@pocketjs/framework/modality";
import { oskHeight, TextField, type OskController } from "@pocketjs/framework/osk";
import { hasFeature, platform } from "@pocketjs/framework/platform";
import { VirtualList, type VirtualListHandle } from "@pocketjs/framework/virtual-list";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { loadCard, pumpDriver } from "../driver.ts";
import Player from "../player.tsx";
import { createYoutubeStore, type YoutubeStore } from "../store.ts";
import type { ResultItem } from "../protocol.ts";

const INK = CLASSIC.ink;
const DIM = CLASSIC.dim;
const BLUE = CLASSIC.blue;
const BG = CLASSIC.background;

/** Row pitch of the results column: 64px row + 4px gap. */
const ROW_STEP = 68;
/** The glossy title bar and the footer strip. */
const NAV_H = 36;
const FOOTER_H = 24;
/** Results viewport height (272 minus bar, search row and footer) — the
 *  scroll clamp keeps the focused row fully inside it. */
const VIEW_H = 272 - NAV_H - 36 - FOOTER_H;
/** The classic keyboard's docked height on this surface. */
const KEYBOARD_H = oskHeight("primary", "classic");

const SPINNER_FRAMES = [
  "spin-00.svg",
  "spin-01.svg",
  "spin-02.svg",
  "spin-03.svg",
  "spin-04.svg",
  "spin-05.svg",
  "spin-06.svg",
  "spin-07.svg",
];

/** The busy spinner (baked SVG frames, ~7.5 rev/s at step 3). */
function Spinner(props: { size?: number }) {
  const src = createSpriteAnimation(SPINNER_FRAMES, { frameStep: 3 });
  return <Image src={src()} style={{ width: props.size ?? 22, height: props.size ?? 22 }} />;
}

export default function SingleScreen() {
  const store = createYoutubeStore();

  // The one per-frame pump: driver IO (svc poll + card loader) plus the
  // connect-phase retry. Registered at the root so it outlives screens.
  onFrame(() => {
    pumpDriver();
    store.connectTick();
  });

  return (
    <View class="w-full h-full flex-col" style={{ bgColor: BG }}>
      <Show when={store.phase() === "player"} fallback={<Browse store={store} />}>
        <Player store={store} />
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Classic chrome
// ---------------------------------------------------------------------------

/** The glossy bar: a two-stop gloss over a darker base, a white top line
 *  and a dark bottom line, the title embossed in two passes. */
function TitleBar(props: { title: string; trailing?: string }) {
  return (
    <View class="relative w-full h-[36] bg-gradient-to-b from-[#fafbfc] via-[#ccd1d9] to-[#b6beca]">
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: 480, height: 1, bgColor: "#ffffff" }} />
      <View class="absolute" style={{ insetL: 0, insetT: 35, width: 480, height: 1, bgColor: "#7f8998" }} />
      <View class="absolute items-center" style={{ insetL: 0, insetT: 11, width: 480 }}>
        <Text class="text-sm font-bold" style={{ textColor: "#ffffff" }}>{props.title}</Text>
      </View>
      <View class="absolute items-center" style={{ insetL: 0, insetT: 10, width: 480 }}>
        <Text class="text-sm font-bold" style={{ textColor: "#46566c" }}>{props.title}</Text>
      </View>
      <Show when={props.trailing}>
        <View class="absolute" style={{ insetR: 12, insetT: 12 }}>
          <Text class="text-xs" style={{ textColor: DIM }}>{props.trailing}</Text>
        </View>
      </Show>
    </View>
  );
}

function Footer(props: { text: string; alert?: boolean }) {
  return (
    <View class="relative w-full h-[24] items-center justify-center bg-gradient-to-b from-[#eef0f4] via-[#c6cdd6] to-[#bac2ce]">
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: 480, height: 1, bgColor: "#8b96a4" }} />
      <View class="absolute" style={{ insetL: 0, insetT: 1, width: 480, height: 1, bgColor: "#ffffff" }} />
      <Text class="text-xs" style={{ textColor: props.alert ? "#a63838" : DIM, lineHeight: 12 }}>{props.text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connect + browse
// ---------------------------------------------------------------------------

function Browse(props: { store: YoutubeStore }) {
  // The field owns its OSK (TextField, docs/TOUCH.md §1); the controller
  // ref keeps the squeeze layout and the △ shortcut.
  const [osk, setOsk] = createSignal<OskController | null>(null);

  // Rows the list serves: real results plus the LOAD MORE sentinel.
  const rowCount = () => props.store.results().length + (props.store.hasMore() ? 1 : 0);
  const [list, setList] = createSignal<VirtualListHandle | null>(null);
  const focusedRow = () => list()?.focusedIndex() ?? 0;
  // Opening the OSK squeezes the list viewport, never the OSK.
  const listH = () => (osk()?.isOpen() ? VIEW_H - KEYBOARD_H : VIEW_H);

  // While the OSK is open these are muted by its modal block — the keyboard
  // owns every button until it closes. The d-pad row walk and ○-to-play now
  // ride the framework focus manager through the VirtualList's rows.
  onButtonPress(BTN.TRIANGLE, () => osk()?.open());
  onButtonPress(BTN.START, () => props.store.search());

  // A fresh search replaces the list: focus row 0 (the same entry point the
  // d-pad walk uses) so ○ plays the first result immediately.
  createEffect(() => {
    props.store.searchSerial();
    // Depend on the handle too: the delivery that brings the first results
    // also MOUNTS the list — the ref lands after this effect's first run.
    list()?.focusRow(0);
  });

  const pressRow = (i: number): void => {
    const item = props.store.results()[i];
    if (item) props.store.play(item);
    else if (props.store.hasMore()) props.store.loadMore(); // the sentinel row
  };

  const transportLabel = () =>
    props.store.phase() === "connect"
      ? "Waiting for host"
      : props.store.transport() === "usb"
        ? platform.target === "vita" ? "WiFi · PKNT" : "USB · PSPLINK"
        : "HTTP · dev";

  const hint = () =>
    hasFeature("input.touch")
      ? `Tap to play · ${glyph("triangle")} search`
      : `↕ browse · ${glyph("circle")} play · ${glyph("triangle")} search`;

  return (
    <View class="flex-col w-full h-full">
      <TitleBar title="Pocket YouTube" trailing={transportLabel()} />

      <Show when={props.store.phase() === "browse"} fallback={<ConnectScreen />}>
        {/* Search field */}
        <View class="flex-row items-center px-3" style={{ height: 36, paddingT: 4, paddingB: 4 }}>
          <TextField
            value={props.store.query}
            onInput={props.store.setQuery}
            onSubmit={() => props.store.search()}
            placeholder="Search YouTube"
            theme="classic"
            hint={`${glyph("cross")} cancel · ${glyph("start")} search`}
            class="grow h-[28] rounded-lg bg-white border border-[#9aa5b2] px-3 py-1 focus:border-[#2676cb] active:bg-[#e3effe]"
            ref={setOsk}
          />
        </View>

        {/* Results: the framework VirtualList — touch pan/fling + tap on
            hosts with contacts, d-pad focus walk everywhere, only the
            visible slice mounted. Rows are host-rendered full-width
            textures (thumb left, text right, chevron far right). */}
        <View class="flex-1 mx-3">
          <Show
            when={props.store.results().length > 0}
            fallback={
              // The empty state shrinks with the list so the keyboard never
              // covers its copy.
              <View class="items-center justify-center flex-col gap-2" style={{ height: listH() }}>
                <Show when={props.store.searching()}>
                  <Spinner size={26} />
                </Show>
                <Text class="text-sm font-bold" style={{ textColor: props.store.status().startsWith("Error") ? "#a63838" : INK }}>
                  {props.store.status() || (props.store.searching() ? "Searching…" : "Search videos")}
                </Text>
                <Show when={!props.store.status() && !props.store.searching()}>
                  <Text class="text-xs" style={{ textColor: DIM }}>
                    {hasFeature("input.touch") ? "Tap the field to type." : `${glyph("triangle")} opens the keyboard.`}
                  </Text>
                </Show>
              </View>
            }
          >
            <VirtualList
              count={rowCount()}
              rowHeight={ROW_STEP}
              height={listH()}
              overscan={68}
              inputActive={() => !osk()?.isOpen()}
              onRowPress={pressRow}
              // Touch scrolls fetch the next page as the end approaches;
              // the d-pad flow keeps its explicit ○ on the sentinel row
              // (nearEnd would double-fetch under the chase scroll).
              onNearEnd={
                hasFeature("input.touch")
                  ? () => {
                      if (props.store.hasMore() && !props.store.searching()) props.store.loadMore();
                    }
                  : undefined
              }
              ref={setList}
              renderRow={(i) => (
                <Show
                  when={i < props.store.results().length}
                  fallback={
                    <LoadMoreRow active={focusedRow() === i} busy={props.store.searching()} />
                  }
                >
                  <ResultRow item={props.store.results()[i]} active={focusedRow() === i} />
                </Show>
              )}
            />
          </Show>
        </View>
        <Footer
          text={
            props.store.status() ||
            (props.store.results().length > 0
              ? `${Math.min(focusedRow(), props.store.results().length - 1) + 1}/${props.store.results().length} · ${hint()}`
              : hint())
          }
          alert={props.store.status().startsWith("Error")}
        />
      </Show>
    </View>
  );
}

function ConnectScreen() {
  return (
    <View class="flex-1 items-center justify-center flex-col gap-2">
      <Text class="text-sm font-bold animate-pulse" style={{ textColor: INK }}>
        Connect USB and start the Mac companion
      </Text>
      <Text class="text-xs" style={{ textColor: DIM }}>
        {"bun host/serve.ts --dir <usbhostfs root>"}
      </Text>
    </View>
  );
}

/** The selection wash, drawn ON TOP of the row content — an absolute
 *  overlay can never lose the z-fight against the card image (a border on
 *  the image's own wrapper did, on hardware). A translucent blue tint, a
 *  blue bar at the left edge and a blue rim: the classic selected row. The
 *  tint and the rim are two nodes: on the PSP GE a rounded, bordered node
 *  with a translucent fill paints the border colour as an opaque fill. */
function Selection(props: { active: boolean }) {
  return (
    <Show when={props.active}>
      <View class="absolute" style={{ insetL: 1, insetT: 1, insetR: 1, insetB: 1, bgColor: "#2676cb22" }} />
      <View class="absolute inset-0 rounded-md border border-[#9cbce4]" />
      <View class="absolute" style={{ insetL: 0, insetT: 4, width: 3, height: 56, bgColor: CLASSIC.selectedBar }} />
    </Show>
  );
}

/** The infinite-list sentinel: focusable like a row, ○ fetches the next
 *  page of the current search. */
function LoadMoreRow(props: { active: boolean; busy: boolean }) {
  return (
    <View class="relative w-full h-[64] rounded-md bg-white border border-[#ccd0d6] items-center justify-center flex-row gap-2">
      <Show when={props.busy}>
        <Spinner />
      </Show>
      <Text class="text-sm font-bold" style={{ textColor: props.active ? BLUE : DIM }}>
        {props.busy ? "Loading more…" : `Load more · ${glyph("circle")}`}
      </Text>
      <Selection active={props.active} />
    </View>
  );
}

/** One host-rendered full-width result row. Classic hosts: a single 512x64
 *  texture (456 visible — the pow2 tail is clipped by the wrapper).
 *  Density-2 hosts: the host sends the SAME card as two 512x128 halves
 *  (TEX_MAX_DIM caps uploads at 512) drawn side by side at logical
 *  half-width — 1:1 texels on a 2x panel, sharp text. Textures load through
 *  the driver's one-per-frame queue and are freed with the row. */
function ResultRow(props: { item: ResultItem; active: boolean }) {
  const hd = props.item.cardHD;
  const [handle, setHandle] = createSignal(-1);
  const [handleR, setHandleR] = createSignal(-1);
  let node: NodeMirror | undefined;
  let nodeR: NodeMirror | undefined;
  let alive = true;

  loadCard(hd ? hd[0] : props.item.card, (h) => {
    if (!alive) {
      if (h >= 0) getOps().freeTexture?.(h);
      return;
    }
    setHandle(h);
  });
  if (hd) {
    loadCard(hd[1], (h) => {
      if (!alive) {
        if (h >= 0) getOps().freeTexture?.(h);
        return;
      }
      setHandleR(h);
    });
  }
  onCleanup(() => {
    alive = false;
    const h = handle();
    if (h >= 0) getOps().freeTexture?.(h);
    const hr = handleR();
    if (hr >= 0) getOps().freeTexture?.(hr);
  });
  createEffect(() => {
    const h = handle();
    if (h >= 0 && node) getOps().setImage(node.id, h);
  });
  createEffect(() => {
    const hr = handleR();
    if (hr >= 0 && nodeR) getOps().setImage(nodeR.id, hr);
  });

  return (
    <View class="relative w-full h-[64] rounded-md overflow-hidden">
      <Show
        when={handle() >= 0}
        fallback={
          <View class="w-full h-[64] rounded-md bg-white border border-[#ccd0d6] items-center justify-center">
            <Text class="text-xs" style={{ textColor: DIM }}>
              …
            </Text>
          </View>
        }
      >
        {/* Absolute: an IN-FLOW wide image gets flex-shrunk to the 456
            wrapper (observed on hardware as an 11% squeeze — the baked
            corner arcs drifted ~50px into the row). Out of flow it renders
            1:1 and the wrapper's scissor clips the pow2 tail. */}
        <Image
          nodeRef={(n) => (node = n)}
          class="absolute"
          style={{ insetT: 0, insetL: 0, width: hd ? 256 : 512, height: 64 }}
        />
        <Show when={hd && handleR() >= 0}>
          <Image
            nodeRef={(n) => (nodeR = n)}
            class="absolute"
            style={{ insetT: 0, insetL: 256, width: 256, height: 64 }}
          />
        </Show>
      </Show>
      <Selection active={props.active} />
    </View>
  );
}
