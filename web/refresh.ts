/**
 * When the page reads the machines again, and which ones. Every machine but this one is reached
 * through the bus and a tunnel, so the page asks only while it is visible: every machine every
 * 20 s, and in between, while a task runs, only the machines with one running every 4 s.
 */

export const FULL_MS = 20_000;
export const LIVE_MS = 4_000;

export interface Next {
  /** Milliseconds until the next read. */
  wait: number;
  /** The machines to read then (`via`, "" for this one); null for every machine, the list included. */
  only: string[] | null;
}

/**
 * The next read after one that ended at `now`, the last full read having ended at `lastFull`.
 * `live` holds the machines with a task running. Null while the page is hidden: nothing is read
 * until it shows again.
 */
export function nextRead(o: { now: number; lastFull: number; live: Iterable<string>; hidden: boolean }): Next | null {
  if (o.hidden) return null;
  const fullIn = Math.max(0, o.lastFull + FULL_MS - o.now);
  const live = [...new Set(o.live)];
  if (!live.length || fullIn <= LIVE_MS) return { wait: fullIn, only: null };
  return { wait: LIVE_MS, only: live };
}
