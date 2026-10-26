import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Node's test runner loads TypeScript directly.
import { CacheWriteQueue } from "../app/lib/client-cache.ts";
// @ts-expect-error Node's test runner loads TypeScript directly.
import { collectionPage } from "../app/lib/collection-page.ts";

test("display cache coalesces edits before serializing and keeps the latest snapshot", () => {
  const writes: string[] = [];
  const queue = new CacheWriteQueue((_key: string, value: string) => writes.push(value));
  let serialized = 0;
  queue.enqueue("media", { toJSON() { serialized++; return "obsolete"; } });
  queue.enqueue("media", { toJSON() { serialized++; return "latest"; } });
  assert.equal(serialized, 0);
  queue.flush();
  assert.equal(serialized, 1);
  assert.deepEqual(writes, ['"latest"']);
  queue.flush();
  assert.equal(writes.length, 1);
});

test("an unavailable cache key does not block other collection snapshots", () => {
  const writes: [string, string][] = [];
  const queue = new CacheWriteQueue((key: string, value: string) => {
    if (key === "media") throw new Error("Quota exceeded");
    writes.push([key, value]);
  });
  queue.enqueue("media", [1]);
  queue.enqueue("devices", [2]);
  assert.doesNotThrow(() => queue.flush());
  assert.deepEqual(writes, [["devices", "[2]"]]);
});

test("a cache serialization error leaves later snapshots usable", () => {
  const writes: string[] = [];
  const queue = new CacheWriteQueue((_key: string, value: string) => writes.push(value));
  queue.enqueue("invalid", { toJSON() { throw new Error("bad value"); } });
  queue.enqueue("valid", 42);
  queue.flush();
  assert.deepEqual(writes, ["42"]);
});

test("collection pages cover every result once and never mount more than 60", () => {
  const ids = Array.from({ length: 135 }, (_, i) => i + 1);
  const shown: number[] = [];
  for (let page = 0; page < 3; page++) {
    const range = collectionPage(ids.length, page);
    const items = ids.slice(range.start, range.end);
    assert.ok(items.length <= 60);
    shown.push(...items);
  }
  assert.deepEqual(shown, ids);
});

test("collection pages clamp after filtering and handle empty and exact-size results", () => {
  assert.deepEqual(collectionPage(0, 4), { page: 0, pages: 1, start: 0, end: 0 });
  assert.deepEqual(collectionPage(60, 1), { page: 0, pages: 1, start: 0, end: 60 });
  assert.deepEqual(collectionPage(65, 8), { page: 1, pages: 2, start: 60, end: 65 });
  assert.equal(collectionPage(65, -1).page, 0);
});
