import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Node's TypeScript loader requires an explicit extension.
import { changedFields, mergePendingChanges, PreferenceWriter } from "../app/lib/client-save-state.ts";

test("a failed initial preference read never writes cached defaults", async () => {
  const writer = new PreferenceWriter<{ font: string; collections: string[] }>();
  let writes = 0;
  const write = async () => { writes++; };
  assert.equal(await writer.save({ font: "modern", collections: [] }, write), false);
  assert.equal(writes, 0);
  const loaded = { font: "serif", collections: ["珍藏"] };
  writer.initialize(loaded);
  assert.equal(await writer.save(loaded, write), false);
  assert.equal(writes, 0);
});

test("preference writes are ordered and send only changed fields", async () => {
  const writer = new PreferenceWriter<{ font: string; softness: number }>();
  writer.initialize({ font: "modern", softness: 72 });
  const calls: object[] = [];
  let finishFirst: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => { finishFirst = resolve; });
  const write = async (patch: object) => {
    calls.push(patch);
    if (calls.length === 1) await firstWrite;
  };
  const first = writer.save({ font: "serif", softness: 72 }, write);
  const second = writer.save({ font: "serif", softness: 80 }, write);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ font: "serif" }]);
  finishFirst!();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [{ font: "serif" }, { softness: 80 }]);
});

test("failed preference saves retain the delta for an explicit retry", async () => {
  const writer = new PreferenceWriter<{ collections: string[]; font: string }>();
  writer.initialize({ collections: ["原合集"], font: "serif" });
  const next = { collections: ["原合集", "新合集"], font: "serif" };
  await assert.rejects(writer.save(next, async () => { throw new Error("offline"); }), /offline/);
  let retried: object | undefined;
  assert.equal(await writer.save(next, async (patch) => { retried = patch; }), true);
  assert.deepEqual(retried, { collections: ["原合集", "新合集"] });
});

test("editing a title does not resend an old gallery image list", () => {
  const original = { title: "画廊", images: [{ id: 1, thumbnail: "/a.webp" }], score: 8 };
  assert.deepEqual(changedFields({ ...original, title: "新标题" }, original), { title: "新标题" });
  assert.deepEqual(changedFields({ ...original, score: 9 }, original), { score: 9 });
  assert.deepEqual(changedFields({ ...original, images: [] }, original), { images: [] });
});

test("a later progress edit retains an earlier failed score and metadata edit", () => {
  const pending = [
    { score: 8, metadata: { calendarTracking: false } },
    { progress: 4, metadata: { overview: "新的简介" } },
  ];
  assert.deepEqual(mergePendingChanges(pending), {
    score: 8, progress: 4, metadata: { calendarTracking: false, overview: "新的简介" },
  });
});

test("a retry can explicitly clear a value from an earlier failed edit", () => {
  assert.deepEqual(mergePendingChanges([
    { score: 8, images: [{ id: 1 }] },
    { score: null, images: [] },
  ]), { score: null, images: [] });
});
