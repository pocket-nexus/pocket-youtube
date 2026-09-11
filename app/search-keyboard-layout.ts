/** Clear's staggered portrait layout, sized for the independent touch display. */
export type KeyboardLayer = "lower" | "upper" | "numbers" | "symbols";
export type SearchKey = { id: string; x: number; y: number; w: number; ch?: string; action?: "shift" | "delete" | "numbers" | "letters" | "symbols" | "search"; label?: string };
export const KEYBOARD_TOP = 100, KEY_HEIGHT = 30, KEY_PITCH = 34;
const grid = (text: string, x: number, row: number) => [...text].map((ch, col) => ({ x: x + col * 32, y: KEYBOARD_TOP + row * KEY_PITCH, w: 28, ch }));
const action = (name: SearchKey["action"], x: number, w: number, row: number, label?: string) => ({ action: name, x, w, y: KEYBOARD_TOP + row * KEY_PITCH, label });
export function searchKeys(layer: KeyboardLayer): SearchKey[] {
  const letters = layer === "lower" || layer === "upper";
  const rows = letters ? [grid(layer === "upper" ? "QWERTYUIOP" : "qwertyuiop", 2, 0),
    grid(layer === "upper" ? "ASDFGHJKL" : "asdfghjkl", 18, 1),
    [action("shift", 2, 38, 2), ...grid(layer === "upper" ? "ZXCVBNM" : "zxcvbnm", 50, 2), action("delete", 280, 38, 2)]] :
    [grid(layer === "numbers" ? "1234567890" : "[]{}#%^*+=", 2, 0), grid(layer === "numbers" ? '-/:;()$&@"' : "_\\|~<>!?.,", 2, 1),
      [action(layer === "numbers" ? "symbols" : "numbers", 2, 38, 2, layer === "numbers" ? "#+=" : "123"),
        ...[...".,?!'"].map((ch, col) => ({ ch, x: 52 + col * 44, y: KEYBOARD_TOP + 2 * KEY_PITCH, w: 40 })), action("delete", 280, 38, 2)]];
  rows.push([action(letters ? "numbers" : "letters", 2, 48, 3, letters ? "123" : "ABC"),
    { ch: " ", label: "space", x: 54, y: KEYBOARD_TOP + 3 * KEY_PITCH, w: 182 }, action("search", 240, 78, 3, "Search")]);
  return rows.flatMap((row, r) => row.map((key, c) => ({ ...key, id: `${r}:${c}` })));
}
export function searchKeyAt(keys: SearchKey[], x: number, y: number) {
  return keys.find(key => x >= key.x - 1 && x < key.x + key.w + 2 && y >= key.y - 1 && y < key.y + KEY_HEIGHT + 2);
}
