import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createKeyboardTouch, type OskController } from "@pocketjs/framework/osk";
import { virtualNow } from "@pocketjs/framework/clock";
import { onFrame, pushButtonHandlerBlock } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createGesture, pushTouchBlock } from "@pocketjs/framework/gesture";
import { searchKeys, searchKeyAt, KEY_HEIGHT, type KeyboardLayer, type SearchKey } from "./search-keyboard-layout.ts";
const CAPS: Record<number, [string, string, number]> = {
  28: ["key-28.png", "key-28-down.png", 32], 38: ["key-38.png", "key-38-down.png", 64],
  40: ["key-40.png", "key-40-down.png", 64], 48: ["key-48.png", "key-48-down.png", 64],
  78: ["key-78.png", "key-78-down.png", 128], 182: ["key-182.png", "key-182-down.png", 256],
};
/** Character keys own a contact, never focus. Clear's hold controller owns repeats/trackpad. */
export function SearchKeyboard(props: { osk: OskController }) {
  const [layer, setLayer] = createSignal<KeyboardLayer>("lower"), [locked, setLocked] = createSignal(false);
  const [pressed, setPressed] = createSignal(""), [popup, setPopup] = createSignal<SearchKey>();
  const [tracking, setTracking] = createSignal(false);
  const keys = createMemo(() => searchKeys(layer()));
  let owner = -1, shiftAt = -10, previous = 0, firstFrame = true;
  onCleanup(pushButtonHandlerBlock()); onCleanup(pushTouchBlock());
  const touch = createKeyboardTouch({ space: () => props.osk.insert(" "), backspace: props.osk.backspace,
    caret: props.osk.moveCaret, trackpad: active => { setTracking(active); if (active) setPopup(undefined); } });
  onCleanup(() => touch.cancel());
  function shift() {
    const now = virtualNow();
    if (layer() === "upper" && now - shiftAt < .35) setLocked(true);
    else { setLocked(false); setLayer(layer() === "upper" ? "lower" : "upper"); }
    shiftAt = now;
  }
  function activate(key: SearchKey) {
    if (key.ch !== undefined && key.ch !== " ") {
      props.osk.insert(key.ch);
      if (layer() === "upper" && !locked()) setLayer("lower");
    } else if (key.action === "shift") shift();
    else if (key.action === "search") props.osk.commit();
    else if (key.action === "numbers" || key.action === "symbols") { setLayer(key.action); setLocked(false); }
    else if (key.action === "letters") { setLayer("lower"); setLocked(false); }
  }
  const release = (id: number, cancelled = false) => {
    touch.release(id, cancelled);
    if (owner === id) { owner = -1; setPressed(""); setPopup(undefined); }
  };
  createGesture({ surface: "auxiliary", allowWhenBlocked: true, tapSlop: 9999,
    region: { rect: () => ({ x: 0, y: 74, w: 320, h: 166 }) },
    onDown(c) {
      const key = searchKeyAt(keys(), c.x, c.y); if (!key) return;
      if (!touch.begin(c.id, c.x, c.y, key.action === "delete" ? "backspace" : key.ch === " " ? "space" : "other",
        { x: key.x, y: key.y, w: key.w, h: KEY_HEIGHT }, virtualNow())) return;
      owner = c.id; setPressed(key.id); setPopup(key.ch && key.ch !== " " ? key : undefined); activate(key);
    },
    onMove(c) { touch.move(c.id, c.x, c.y); }, onUp: c => release(c.id), onCancel: c => release(c.id, true),
  });
  onFrame(buttons => {
    touch.step(virtualNow());
    if (firstFrame) { firstFrame = false; previous = buttons; return; }
    const down = buttons & ~previous; previous = buttons;
    if (down & BTN.CROSS) props.osk.cancel();
    else if (down & (BTN.START | BTN.CIRCLE)) props.osk.commit();
    else if (down & BTN.LEFT) props.osk.moveCaret(-1);
    else if (down & BTN.RIGHT) props.osk.moveCaret(1);
    else if (down & BTN.SQUARE) props.osk.backspace();
    else if (down & BTN.LTRIGGER) shift();
    else if (down & BTN.RTRIGGER) setLayer(layer() === "numbers" ? "lower" : "numbers");
  });
  return <View class="absolute" style={{ insetL: 0, insetT: 74, width: 320, height: 166, bgColor: "#aeb5bf" }}>
    <Image src="keyboard-bed.png" class="absolute" style={{ insetL: 0, insetT: 0, width: 512, height: 256 }} />
    <View class="absolute items-center justify-center" style={{ insetT: 5, width: 320 }}><Text class="text-xs" style={{ textColor: "#4f5d70" }}>{tracking() ? "Slide to move cursor" : "B Cancel    START Search"}</Text></View>
    <For each={keys()}>{key => {
      const selected = () => pressed() === key.id || key.action === "shift" && layer() === "upper";
      const cap = CAPS[key.w];
      return <View class="absolute" style={{ insetL: key.x, insetT: key.y - 74, width: key.w, height: KEY_HEIGHT, overflow: 1 }}>
        <Image src={selected() ? cap[1] : cap[0]} class="absolute" style={{ insetL: 0, insetT: 0, width: cap[2], height: 32 }} />
        <Show when={key.action === "shift" || key.action === "delete"} fallback={
          <View class="absolute items-center justify-center" style={{ width: key.w, height: KEY_HEIGHT }}>
            <Text class={key.ch && key.ch !== " " ? "text-sm" : "text-xs font-bold"} style={{ textColor: key.action === "search" || selected() ? "#ffffff" : "#293545", opacity: tracking() ? .3 : 1 }}>{key.label ?? key.ch}</Text>
          </View>}>
          <Image src={key.action === "delete" ? "keyboard-delete.png" : locked() ? "keyboard-caps.png" : "keyboard-shift.png"}
            class="absolute" style={{ insetL: (key.w - 20) / 2, insetT: 5, width: 20, height: 20 }} />
        </Show>
      </View>;
    }}</For>
    <Show when={popup()}>{key => <View class="absolute" style={{ insetL: Math.max(0, Math.min(276, key().x + key().w / 2 - 22)), insetT: key().y - 74 - 43, width: 44, height: 54 }}>
      <Image src="keyboard-popup.png" class="absolute" style={{ width: 64, height: 64 }} />
      <View class="absolute items-center" style={{ insetT: 3, width: 44 }}><Text class="text-xl" style={{ textColor: "#243347" }}>{key().ch}</Text></View>
    </View>}</Show>
  </View>;
}
