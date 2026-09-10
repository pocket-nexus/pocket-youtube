import { expect, test } from "bun:test";
import { createClassicArt, thumbnailArt } from "../host/classic-art.ts";
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
