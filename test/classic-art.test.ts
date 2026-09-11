import { expect, test } from "bun:test";
import { createClassicArt, thumbnailArt } from "../host/classic-art.ts";
import { cardFont, drawText, fitLines, textWidth } from "../host/cards.ts";
import { uploadIndexedImage } from "../vendor/pocketjs/framework/src/indexed-image.ts";

test("titles do not wait for thumbnails; downloads are bounded, deduplicated and cached", async () => {
  const pending: ((value: ReturnType<typeof thumbnailArt>) => void)[] = [];
  let downloads = 0;
  const art = createClassicArt(() => { downloads++; return new Promise(resolve => pending.push(resolve)); });
  for (let i = 0; i < 8; i++) expect(art.thumbnail(`video00000${i}`)).toEqual({ pending: true });
  expect(downloads).toBe(2);
  const title = await art.text({ title: "京都の散歩 · A quiet afternoon", channel: "Pocket travel" });
  expect(title.coverage.length).toBe(2304);
  expect(Buffer.from(title.coverage, "base64").some(value => value !== 0)).toBe(true);
  expect(JSON.stringify(title).length).toBeLessThan(2500);
  expect(downloads).toBe(2);
  const rgba = new Uint8Array(72 * 40 * 4);
  for (let i = 0; i < 72 * 40; i++) rgba.set(i % 2 ? [20, 160, 230, 255] : [240, 60, 20, 255], i * 4);
  const thumbnail = thumbnailArt(rgba);
  expect(JSON.stringify(thumbnail).length).toBeLessThan(2500);
  let decoded: Uint8Array | undefined;
  uploadIndexedImage(thumbnail, { uploadTexture: data => { decoded = data; return 1; } });
  expect([...decoded!.slice(0, 8)]).toEqual([240, 60, 20, 255, 20, 160, 230, 255]);
  pending[0](thumbnail); await Bun.sleep(0);
  expect(art.thumbnail("video000000")).toEqual(thumbnail);
  expect(art.thumbnail("video000000")).toEqual(thumbnail);
  expect(downloads).toBe(2);
});


test("Linux fallback font shapes and rasterizes within the same measured line bounds", async () => {
  const font = await cardFont(new URL("../vendor/pocketjs/assets/fonts/Inter-Regular.ttf", import.meta.url).pathname);
  try {
    expect(() => font.getAdvanceWidth("Pocket", 12)).toThrow("not yet supported");
    const lines = fitLines("Office café · A quiet afternoon in Kyoto", 12, 192, 2);
    expect(lines.length).toBeGreaterThan(0);
    const rgba = new Uint8Array(192 * 36 * 4);
    for (const [row, line] of lines.entries()) {
      expect(textWidth(line, 12)).toBeLessThanOrEqual(192);
      drawText(rgba, 192, 36, line, 0, 12 + row * 13, 12, [255, 255, 255]);
    }
    expect(rgba.some(value => value > 0)).toBe(true);
  } finally { await cardFont(); }
});
