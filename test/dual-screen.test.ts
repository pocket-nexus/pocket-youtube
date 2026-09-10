import { expect, test } from "bun:test";
import { createWasmUi } from "../vendor/pocketjs/hosts/web/wasm-ops.js";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { OSK_H, OSK_PAD, OSK_ROW_H, OSK_GAP, OSK_LAYERS, layoutRows } from "../vendor/pocketjs/framework/src/osk-layout.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { mkdirSync } from "node:fs";

test("auxiliary keyboard, playback controls, local scrubbing and reconnect use the complete app", async () => {
  const wasm = await createWasmUi(await Bun.file("vendor/pocketjs/hosts/web/pocketjs.wasm").arrayBuffer(), { width: 400, height: 240 });
  wasm.createAuxiliarySurface(320, 240);
  const globals = globalThis as Record<string, any>, replies: string[] = [], commands: any[] = [];
  let session = 1, opened = 0, closed = 0, paused = false, volume = 1, position = 0;
  let phase = "idle", job = 0;
  const jobs = new Map<number, any>();
  const source = { host: "127.0.0.1", port: 9000, token: "a".repeat(64) };
  const pixels = new Uint8Array(512 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) pixels.set([x / 2, y, 110, 255], (y * 512 + x) * 4);
  const texture = wasm.ops.uploadTexture(pixels, 512, 256, 3);
  globals.ui = wasm.ops;
  globals.__pak = await Bun.file("vendor/pocketjs/dist/3ds/guest/pocket-youtube.pak").arrayBuffer();
  globals.__pocketEffectDriver = undefined; globals.__pocketEffectTrace = undefined; globals.__pocketDevtoolsTransport = undefined;
  globals.offload = {
    session: () => session, take: () => replies.shift() ?? null,
    submit: (raw: string) => {
      const request = JSON.parse(raw), data = JSON.parse(request.payload);
      let result: any = {};
      if (request.method === "youtube.command") {
        commands.push(data);
        if (data.t === "hello") result = { t: "ready" };
        else if (data.t === "search") {
          result = { job: ++job }; jobs.set(job, { t: "results", items: [{ videoId: "abcdefghijk", title: "Video", channel: "Channel", durationS: 120, views: 1, card: "abcdefghijk" }] });
        } else if (data.t === "play" || data.t === "seek") {
          position = data.to ?? data.position ?? 0;
          result = { job: ++job }; jobs.set(job, { t: "playing", videoId: "abcdefghijk", title: "Video", durationS: 120, fps: 30, source, stream: source.token, position });
        } else result = { t: "state", playing: false, position };
      } else if (request.method === "youtube.poll") result = { state: "done", value: jobs.get(data.job) };
      else if (request.method === "youtube.art") result = { coverage: Buffer.alloc(304 * 16 / 4).toString("base64"), width: 304, height: 16 };
      replies.push(JSON.stringify({ id: request.id, payload: JSON.stringify(result) })); return true;
    },
    uploadCoverage: () => wasm.ops.uploadTexture(new Uint8Array(512 * 16 * 4), 512, 16, 3),
  };
  globals.media = {
    open: () => { opened++; phase = "playing"; return true; }, close: () => { closed++; phase = "idle"; },
    paused: (value: boolean) => { paused = value; }, volume: (value: number) => { volume = value; }, texture: () => texture,
    status: () => JSON.stringify({ phase: paused && phase === "playing" ? "paused" : phase, positionMs: position * 1000, bufferedMs: 300,
      decodedFrames: phase === "playing" ? 30 : 0, presentedFrames: phase === "playing" ? 30 : 0,
      droppedFrames: 0, receivedBytes: 10000, decodeMaxUs: 1000, audioUnderruns: 0, hardware: true, error: "" }),
  };
  (0, eval)(await Bun.file("vendor/pocketjs/dist/3ds/guest/pocket-youtube.js").text());
  const step = (n = 1, x?: number, y?: number, surface = 1) => {
    for (let i = 0; i < n; i++) {
      const touches = x === undefined ? [] : [__packTouch(1, x, y!)];
      const hit = x === undefined ? [] : [(surface ? wasm.ops.hitTestBoundsAuxiliary : wasm.ops.hitTestBounds)!(x, y!)];
      globals.frame(0, undefined, touches, hit, x === undefined ? [] : [surface]); wasm.tick();
      wasm.render(); wasm.renderAuxiliary();
    }
  };
  const tap = (x: number, y: number, surface = 1) => { step(1, x, y, surface); step(1); step(10); };
  mkdirSync("out/dual-screen", { recursive: true });
  const capture = async (name: string) => {
    await Bun.write(`out/dual-screen/${name}-top.png`, encodePNG(wasm.render().slice(), 400, 240));
    await Bun.write(`out/dual-screen/${name}-bottom.png`, encodePNG(wasm.renderAuxiliary().slice(), 320, 240));
  };
  step(20);
  tap(24, 24, 0); expect(commands.filter(c => c.t === "search")).toHaveLength(0);
  tap(24, 24); await capture("keyboard");
  const rows = layoutRows(OSK_LAYERS.lower, 320 - 2 * OSK_PAD);
  const key = (label: string) => {
    for (const row of rows) for (const rect of row) if (rect.key.ch === label || rect.key.action === label) {
      tap(OSK_PAD + rect.x + rect.w / 2, 240 - (4 * 30 + 3 * OSK_GAP + 2 * OSK_PAD) + OSK_PAD + rect.row * (30 + OSK_GAP) + 15); return;
    }
    throw new Error(`Missing key ${label}`);
  };
  key("q"); key("enter"); step(45);
  expect(commands.find(c => c.t === "search")?.q).toBe("q");
  tap(120, 75); step(45); expect(opened).toBe(1);
  await capture("controls");
  tap(160, 128); expect(paused).toBe(true); expect(opened).toBe(1);
  tap(160, 128); expect(paused).toBe(false); expect(opened).toBe(1);
  const before = commands.filter(c => c.t === "seek").length;
  step(1, 60, 70); step(5, 150, 70); step(5, 220, 70);
  expect(commands.filter(c => c.t === "seek")).toHaveLength(before);
  step(); step(45); expect(commands.filter(c => c.t === "seek")).toHaveLength(before + 1);
  expect(commands.find(c => c.t === "seek")?.to).toBeCloseTo(120 * 200 / 280, 2);
  tap(166, 190); expect(volume).toBeCloseTo(66 / 136, 2);
  const selected = opened;
  tap(272, 20); step(20); expect(opened).toBe(selected);
  tap(150, 216); step(10); expect(opened).toBe(selected);
  session = 0; step(15); expect(closed).toBeGreaterThan(0);
  session = 2; step(200); expect(opened).toBe(selected + 1);
  expect(commands.filter(c => c.t === "play").at(-1).position).toBeCloseTo(position, 2);
}, 30000);
