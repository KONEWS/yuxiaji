import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMediaMetadata } from "../app/lib/constants.ts";
import { calendarEntryMatches, isTrackedCalendarEntry, setCalendarTracking } from "../app/lib/calendar-tracking.ts";

const entry = { source: "Bangumi", subjectId: 42, title: "已有收藏", jp: "既存の作品" };
const collection = () => ({
  id: 7, mediaType: "anime", source: "bangumi", subjectId: 42,
  title: entry.title, jp: entry.jp, tags: ["喜欢"],
  score: 9, progress: 8, total: 24, status: "watching", note: "保留长评",
  storageLinks: [{ id: 3, provider: "mega", path: "/archive/show" }],
  metadata: normalizeMediaMetadata({ sources: { bangumi: "42", anilist: "84" }, overview: "保留简介" }),
});

test("existing collections remain tracked until explicitly disabled", () => {
  const item = collection();
  assert.equal(isTrackedCalendarEntry(entry, [item]), true);
  const stopped = setCalendarTracking(item, false);
  assert.equal(calendarEntryMatches(stopped, entry), true, "unfollowed collection must still be reused");
  assert.equal(isTrackedCalendarEntry(entry, [stopped]), false);
  assert.deepEqual(stopped, { ...item, metadata: { ...item.metadata, calendarTracking: false } });
  assert.equal(item.metadata.calendarTracking, undefined, "toggling must not mutate the previous snapshot");
});

test("cancel, persist and resume retain the same collection and all history", () => {
  const item = collection();
  const cancelled = setCalendarTracking(item, false);
  const restored = JSON.parse(JSON.stringify(cancelled));
  restored.metadata = normalizeMediaMetadata(restored.metadata);
  assert.equal(isTrackedCalendarEntry(entry, [restored]), false);
  const resumed = setCalendarTracking(restored, true);
  assert.equal(isTrackedCalendarEntry(entry, [resumed]), true);
  assert.deepEqual(resumed, { ...item, metadata: { ...item.metadata, calendarTracking: true } });
});

test("merged source calendars share the same explicit tracking preference", () => {
  const combined = { ...entry, source: "AniList + Bangumi", subjectId: 42, sourceIds: { anilist: "84", bangumi: "42" } };
  const item = collection();
  assert.equal(isTrackedCalendarEntry(combined, [item]), true);
  assert.equal(isTrackedCalendarEntry(combined, [setCalendarTracking(item, false)]), false);
  assert.equal(isTrackedCalendarEntry({ ...entry, source: "AniList", subjectId: 84 }, [item]), true);
});

test("matching respects media type and source IDs instead of deleting namesakes", () => {
  assert.equal(calendarEntryMatches({ ...collection(), mediaType: "game" }, entry), false);
  assert.equal(calendarEntryMatches({ ...collection(), source: "anilist", metadata: normalizeMediaMetadata() }, entry), false);
  assert.equal(calendarEntryMatches({ ...collection(), subjectId: 99, tags: ["放送追更"], metadata: normalizeMediaMetadata() }, entry), false);
  assert.equal(calendarEntryMatches({ ...collection(), source: "manual", subjectId: undefined, metadata: normalizeMediaMetadata() }, entry), false);
  assert.equal(calendarEntryMatches({ ...collection(), source: "manual", subjectId: undefined, tags: ["放送追更"], metadata: normalizeMediaMetadata() }, entry), true);
});

test("metadata keeps explicit booleans and leaves legacy tracking unspecified", () => {
  assert.equal(normalizeMediaMetadata({ calendarTracking: false }).calendarTracking, false);
  assert.equal(normalizeMediaMetadata({ calendarTracking: true }).calendarTracking, true);
  assert.equal(Object.hasOwn(normalizeMediaMetadata({ calendarTracking: "false" }), "calendarTracking"), false);
  assert.equal(Object.hasOwn(normalizeMediaMetadata(), "calendarTracking"), false);
});
