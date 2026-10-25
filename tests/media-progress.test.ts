import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Node's native TypeScript loader requires an explicit extension.
import { normalizeEditableProgress } from "../app/lib/media-progress.ts";

test("saving TV details preserves watched episodes and the series length", () => {
  assert.deepEqual(normalizeEditableProgress("tv", 24, 8), { total: 24, progress: 8 });
  assert.deepEqual(normalizeEditableProgress("tv", 12, 12), { total: 12, progress: 12 });
});

test("movies and standalone media do not gain episode progress", () => {
  for (const type of ["movie", "music", "visual", "video"]) {
    assert.deepEqual(normalizeEditableProgress(type, 24, 8), { total: 1, progress: 0 });
  }
});

test("collection progress stays within valid whole episode/chapter bounds", () => {
  for (const type of ["tv", "anime", "light_novel", "manga", "game"]) {
    assert.deepEqual(normalizeEditableProgress(type, 12, 18), { total: 12, progress: 12 });
    assert.deepEqual(normalizeEditableProgress(type, 12, -2), { total: 12, progress: 0 });
    assert.deepEqual(normalizeEditableProgress(type, 24.6, 8.8), { total: 24, progress: 8 });
    assert.deepEqual(normalizeEditableProgress(type, Infinity, NaN), { total: 1, progress: 0 });
  }
});
