import { streamSearch, type SearchItem } from "./yt.ts";
export const SEARCH_PAGE_SIZE = 5, SEARCH_LIMIT = 100;
type ReadSearch = (query: string, count: number, signal: AbortSignal) => AsyncIterable<SearchItem>;
/** Query snapshots make page reads idempotent. Only the worker owns subprocesses. */
export function createSearchPages(read: ReadSearch = streamSearch, remember: (row: SearchItem) => void = () => {}) {
  type Snapshot = { rows: SearchItem[]; seen: Set<string>; scanned: number; ended: boolean; task?: AbortController; errorAt: number };
  const snapshots = new Map<string, Snapshot>();
  function start(query: string, snapshot: Snapshot, count: number) {
    const task = new AbortController(); snapshot.task = task; snapshot.errorAt = 0;
    let seen = 0;
    void (async () => {
      try {
        for await (const row of read(query, count, task.signal)) {
          if (task.signal.aborted) return;
          seen++;
          if (!snapshot.seen.has(row.videoId)) {
            snapshot.seen.add(row.videoId); snapshot.rows.push(row); remember(row);
          }
          if (snapshot.rows.length >= SEARCH_LIMIT) break;
        }
        if (!task.signal.aborted) {
          snapshot.scanned = count;
          snapshot.ended = seen < count || count >= SEARCH_LIMIT;
        }
      } catch { if (!task.signal.aborted) snapshot.errorAt = Date.now(); }
      finally { if (snapshot.task === task) snapshot.task = undefined; }
    })();
  }
  return {
    page(query: string, offset: number) {
      if (typeof query !== "string" || !query.trim() || query.length > 200 || !Number.isInteger(offset) || offset < 0 || offset > SEARCH_LIMIT || offset % SEARCH_PAGE_SIZE)
        throw new Error("Invalid search page");
      let snapshot = snapshots.get(query);
      if (!snapshot) {
        while (snapshots.size >= 2) {
          const oldest = snapshots.keys().next().value!; snapshots.get(oldest)?.task?.abort(); snapshots.delete(oldest);
        }
        snapshot = { rows: [], seen: new Set(), scanned: 0, ended: false, errorAt: 0 }; snapshots.set(query, snapshot);
      } else { snapshots.delete(query); snapshots.set(query, snapshot); }
      if (offset === SEARCH_LIMIT) return { offset, items: [], hasMore: false };
      if (snapshot.rows.length >= offset + SEARCH_PAGE_SIZE || snapshot.ended) {
        return { offset, items: snapshot.rows.slice(offset, offset + SEARCH_PAGE_SIZE).map(row => ({ ...row,
          title: row.title.slice(0, 100), channel: row.channel.slice(0, 48), card: row.videoId })),
          hasMore: offset + SEARCH_PAGE_SIZE < SEARCH_LIMIT && (!snapshot.ended || offset + SEARCH_PAGE_SIZE < snapshot.rows.length) };
      }
      if (snapshot.errorAt && Date.now() - snapshot.errorAt < 5000) throw new Error("Search unavailable; retrying");
      if (!snapshot.task) start(query, snapshot, Math.min(SEARCH_LIMIT, Math.max(snapshot.scanned + 20, offset + 20)));
      return { pending: true };
    },
    close() { for (const snapshot of snapshots.values()) snapshot.task?.abort(); snapshots.clear(); },
  };
}
