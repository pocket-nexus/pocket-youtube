import { expect, test } from "bun:test";
import { createSearchPages } from "../host/search-pages.ts";
const row = (i: number) => ({ videoId: `fixture${String(i).padStart(4, "0")}`, title: `Title ${i}`, channel: "Channel", durationS: 120, views: 1 });

test("pages become readable before lookahead finishes and repeat reads share one snapshot", async () => {
  let calls = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const service = createSearchPages(async function* (_, count) {
    calls++; for (let i = 0; i < 5; i++) yield row(i);
    await gate;
    for (let i = 5; i < Math.min(30, count); i++) yield row(i);
  });
  try {
    expect(service.page("video", 0)).toEqual({ pending: true }); await Bun.sleep(0);
    const first = service.page("video", 0);
    expect("items" in first && first.items).toHaveLength(5);
    expect(service.page("video", 0)).toEqual(first);
    expect(service.page("video", 5)).toEqual({ pending: true }); expect(calls).toBe(1);
    finish(); await Bun.sleep(0);
    expect("items" in service.page("video", 15)).toBe(true);
    expect(service.page("video", 20)).toEqual({ pending: true }); await Bun.sleep(0);
    const last = service.page("video", 25);
    expect("items" in last && last.items?.map(item => item.videoId)).toEqual([25, 26, 27, 28, 29].map(i => row(i).videoId));
    expect("hasMore" in last && last.hasMore).toBe(false);
    expect(calls).toBe(2); expect(service.page("video", 0)).toEqual(first);
  } finally { finish(); service.close(); }
});

test("query caches and subprocesses are bounded and old query work is cancelled", async () => {
  const signals: AbortSignal[] = [];
  const service = createSearchPages(async function* (_, __, signal) {
    signals.push(signal);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  service.page("first", 0); service.page("second", 0); service.page("third", 0);
  expect(signals).toHaveLength(3); expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false); service.close(); expect(signals.every(s => s.aborted)).toBe(true);
  for (const offset of [-1, 1, 101, NaN]) expect(() => service.page("query", offset)).toThrow();
});
