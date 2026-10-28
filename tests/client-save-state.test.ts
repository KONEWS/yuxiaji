import assert from "node:assert/strict";
import { test } from "node:test";
import type { DevicePayload } from "../app/lib/client-api";
// @ts-expect-error Node's TypeScript loader requires an explicit extension.
import { changedFields, DeviceDraftWriter, mergePendingChanges, PreferenceWriter } from "../app/lib/client-save-state.ts";

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

const deviceDraft = { name: "测试设备", category: "audio", subCategory: "耳机", status: "active" as const, tags: [] };

test("lost device creation responses replay the original key and preserve newer draft changes", async () => {
  const writer = new DeviceDraftWriter();
  const calls: Array<{ id?: number; idempotencyKey?: string; name: string }> = [];
  const write = async (payload: DevicePayload) => {
    calls.push(payload);
    if (calls.length === 1) throw new Error("response lost after insert");
    return { device: { ...payload, id: 18 } };
  };
  await assert.rejects(writer.save(deviceDraft, write), /response lost/);
  const updated = { ...deviceDraft, name: "修改后的设备" };
  assert.equal((await writer.save(updated, write)).name, updated.name);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], calls[0]);
  assert.ok(calls[0].idempotencyKey);
  assert.equal(calls[2].id, 18);
  assert.equal(calls[2].idempotencyKey, undefined);
  assert.equal(calls[2].name, updated.name);
});

test("a failed update after device recovery retains the confirmed ID for retry", async () => {
  const writer = new DeviceDraftWriter();
  const calls: Array<{ id?: number; idempotencyKey?: string }> = [];
  const write = async (payload: DevicePayload) => {
    calls.push(payload);
    if (calls.length === 1 || calls.length === 3) throw new Error("offline");
    return { device: { ...payload, id: 19 } };
  };
  await assert.rejects(writer.save(deviceDraft, write), /offline/);
  const updated = { ...deviceDraft, name: "新名称" };
  await assert.rejects(writer.save(updated, write), /offline/);
  await writer.save(updated, write);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].id, 19);
  assert.equal(calls[3].idempotencyKey, undefined);
});

test("editing an existing device does not create a new idempotent operation", async () => {
  const writer = new DeviceDraftWriter();
  let submitted: object | undefined;
  const expected = { ...deviceDraft, id: 20 };
  await writer.save(expected, async (payload) => {
    submitted = payload;
    return { device: { ...payload, id: 20 } };
  });
  assert.deepEqual(submitted, expected);
});

test("an unconfirmed device response cannot be presented as a successful save", async () => {
  const writer = new DeviceDraftWriter();
  await assert.rejects(writer.save(deviceDraft, async (payload) => ({ device: { ...payload, id: 0 } })), /服务器未确认/);
});
