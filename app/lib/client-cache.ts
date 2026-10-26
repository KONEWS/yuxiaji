/** Optional display cache, never a substitute for a confirmed server save. */
export class CacheWriteQueue {
  private pending = new Map<string, unknown>();
  private write: (key: string, value: string) => void;
  constructor(write: (key: string, value: string) => void) { this.write = write; }
  enqueue(key: string, value: unknown) { this.pending.set(key, value); }
  flush() {
    const pending = this.pending;
    this.pending = new Map();
    for (const [key, value] of pending) {
      try { this.write(key, JSON.stringify(value)); } catch { /* quota/private mode: cache is optional */ }
    }
  }
}

let queue: CacheWriteQueue | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let idle: number | undefined;

export function flushClientCache() {
  if (timer !== undefined) clearTimeout(timer);
  if (idle !== undefined) window.cancelIdleCallback(idle);
  timer = undefined;
  idle = undefined;
  queue?.flush();
}

export function queueClientCache(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  queue ??= new CacheWriteQueue((cacheKey, encoded) => window.localStorage.setItem(cacheKey, encoded));
  queue.enqueue(key, value);
  // Coalesce bursts before serializing; bounded delay also handles continuous edits.
  if (timer !== undefined || idle !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    if ("requestIdleCallback" in window) idle = window.requestIdleCallback(flushClientCache, { timeout: 1000 });
    else flushClientCache();
  }, 250);
}
