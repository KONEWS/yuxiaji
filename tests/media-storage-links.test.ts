import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaStorageLinkValidationError,
  normalizeMediaStorageUrl,
  sanitizeMediaStorageLink,
// @ts-expect-error Node's native TypeScript loader requires an explicit extension.
} from "../app/lib/media-storage-links.ts";
// @ts-expect-error Node's native TypeScript loader requires an explicit extension.
import { groupStorageLinkRows, normalizeStorageMediaIds, queryStorageLinkBatches } from "../app/lib/media-storage-link-batches.ts";
// @ts-expect-error Node's native TypeScript loader requires an explicit extension.
import { GALLERY_IMAGE_QUERY_BATCH_SIZE, groupGalleryImageRows, normalizeGallerySubjectIds, queryGalleryImageBatches } from "../app/lib/gallery-image-batches.ts";

test("normalizes provider, label and absolute web URL", () => {
  assert.deepEqual(sanitizeMediaStorageLink({
    provider: "  OneDrive  ",
    label: "  Archive   Copy ",
    url: "https://example.com/share?q=1",
    path: " /Media/Show ",
    isPrimary: "true",
    note: " mirror ",
  }), {
    provider: "onedrive",
    label: "Archive Copy",
    url: "https://example.com/share?q=1",
    path: "/Media/Show",
    isPrimary: true,
    note: "mirror",
  });
});

test("allows a provider path without a public URL", () => {
  const link = sanitizeMediaStorageLink({ provider: "webdav", path: "/library/movie.mkv" });
  assert.equal(link.url, "");
  assert.equal(link.path, "/library/movie.mkv");
});

test("rejects unsafe URL schemes and embedded credentials", () => {
  assert.throws(() => normalizeMediaStorageUrl("javascript:alert(1)"), /仅支持 http 或 https/);
  assert.throws(() => normalizeMediaStorageUrl("https://user:pass@example.com/file"), /不能包含用户名或密码/);
});

test("rejects credential fields, including accessCode", () => {
  for (const value of [
    { provider: "drive", url: "https://example.com", accessCode: "1234" },
    { provider: "drive", url: "https://example.com", access_code: "1234" },
    { provider: "drive", url: "https://example.com", pickupCode: "1234" },
    { provider: "drive", path: "/file", credentials: { token: "secret" } },
  ]) {
    assert.throws(() => sanitizeMediaStorageLink(value), MediaStorageLinkValidationError);
  }
});

test("rejects empty locations and oversized fields", () => {
  assert.throws(
    () => sanitizeMediaStorageLink({ provider: "drive" }),
    (error: unknown) => error instanceof MediaStorageLinkValidationError
      && error.status === 400
      && /至少填写一项/.test(error.message),
  );
  assert.throws(() => sanitizeMediaStorageLink({ provider: "x".repeat(65), path: "/file" }), /最多 64/);
});

test("keeps URL-only links independent when path is empty", () => {
  const first = sanitizeMediaStorageLink({ provider: "mega", url: "https://mega.nz/file/first" });
  const second = sanitizeMediaStorageLink({ provider: "mega", url: "https://mega.nz/file/second" });
  assert.equal(first.path, "");
  assert.equal(second.path, "");
  assert.notEqual(first.url, second.url);
});

test("merges a partial update with existing values", () => {
  const previous = sanitizeMediaStorageLink({
    provider: "s3-compatible",
    label: "Cold copy",
    path: "bucket/key",
    isPrimary: true,
    note: "old",
  });
  const updated = sanitizeMediaStorageLink({ note: "new" }, previous);
  assert.equal(updated.provider, previous.provider);
  assert.equal(updated.path, previous.path);
  assert.equal(updated.isPrimary, true);
  assert.equal(updated.note, "new");
});

function storageRow(mediaId: number, id: number, isPrimary = false, userKey = "user-a") {
  const now = Date.now();
  return {
    id,
    userKey,
    mediaId,
    provider: "mega",
    label: `copy-${id}`,
    url: `https://mega.nz/file/${id}`,
    path: "",
    isPrimary,
    state: "verified",
    operationKey: "",
    objectCount: 1,
    totalBytes: 10,
    manifestSha256: "a".repeat(64),
    verifiedAt: now,
    note: "",
    createdAt: now,
    updatedAt: now,
  };
}

function fakeBatchQuery(rows: ReturnType<typeof storageRow>[]) {
  const calls: number[][] = [];
  let active = 0;
  let maxActive = 0;
  const queryBatch = async (batchIds: number[]) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    calls.push([...batchIds]);
    active -= 1;
    const wanted = new Set(batchIds);
    return rows.filter((row) => wanted.has(row.mediaId));
  };
  return { queryBatch, calls, getMaxActive: () => maxActive };
}

test("reads no storage links for an empty id list", async () => {
  let queryCalls = 0;
  const result = await queryStorageLinkBatches([], async () => { queryCalls += 1; return []; });
  assert.equal(queryCalls, 0);
  assert.deepEqual(result, []);
});

test("batches storage-link reads at 90 ids and preserves deterministic grouping", async () => {
  const rows = [
    storageRow(91, 4),
    storageRow(1, 3),
    storageRow(1, 2, true),
    storageRow(181, 5),
  ];
  const { queryBatch, calls, getMaxActive } = fakeBatchQuery(rows);
  const resultRows = await queryStorageLinkBatches([
    ...Array.from({ length: 90 }, (_, index) => index + 1),
    ...Array.from({ length: 90 }, (_, index) => index + 91),
    ...Array.from({ length: 90 }, (_, index) => index + 181),
  ], queryBatch);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((batch) => batch.length), [90, 90, 90]);
  assert.equal(getMaxActive(), 1);
  const result = groupStorageLinkRows(resultRows, (row) => ({ id: row.id, isPrimary: row.isPrimary }));
  assert.deepEqual([...result.keys()], [1, 91, 181]);
  assert.deepEqual(result.get(1)?.map((link) => [link.id, link.isPrimary]), [[2, true], [3, false]]);
});

test("uses one query for 1 or 90 ids and two for 91 ids", async () => {
  for (const count of [1, 90, 91]) {
    const rows = Array.from({ length: count }, (_, index) => storageRow(index + 1, index + 1));
    const fixture = fakeBatchQuery(rows);
    const result = await queryStorageLinkBatches(rows.map((row) => row.mediaId), fixture.queryBatch);
    assert.equal(fixture.calls.length, count === 91 ? 2 : 1);
    assert.equal(result.length, count);
  }
});

test("uses four sequential queries for more than 300 ids", async () => {
  const rows = Array.from({ length: 301 }, (_, index) => storageRow(index + 1, index + 1));
  const fixture = fakeBatchQuery(rows);
  await queryStorageLinkBatches(rows.map((row) => row.mediaId), fixture.queryBatch);
  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.getMaxActive(), 1);
});

test("deduplicates ids before creating batches", async () => {
  assert.deepEqual(normalizeStorageMediaIds([3, 0, -1, 3, 2, 1.5, 2]), [3, 2]);
});

test("does not hide a failed batch query", async () => {
  await assert.rejects(
    () => queryStorageLinkBatches([1], async () => { throw new Error("d1 query failed"); }),
    /d1 query failed/,
  );
});

test("gallery image batches skip empty ids and stay sequential", async () => {
  let calls = 0;
  const result = await queryGalleryImageBatches([], async () => { calls += 1; return []; });
  assert.equal(calls, 0);
  assert.deepEqual(result, []);

  for (const count of [1, 90, 91]) {
    const batches: number[][] = [];
    await queryGalleryImageBatches(Array.from({ length: count }, (_, index) => index + 1), async (ids) => {
      batches.push(ids);
      return ids;
    });
    assert.equal(batches.length, count === 91 ? 2 : 1);
    assert.deepEqual(batches.flat(), Array.from({ length: count }, (_, index) => index + 1));
  }

  const batches: number[][] = [];
  let active = 0;
  let maxActive = 0;
  await queryGalleryImageBatches([0, 1, 1, ...Array.from({ length: 300 }, (_, index) => index + 2)], async (ids) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    batches.push(ids);
    await new Promise((resolve) => setTimeout(resolve, 0));
    active -= 1;
    return ids;
  });
  assert.deepEqual(batches.map((batch) => batch.length), [90, 90, 90, 31]);
  assert.equal(maxActive, 1);
  assert.ok(batches.every((batch) => batch.length <= GALLERY_IMAGE_QUERY_BATCH_SIZE));
  assert.deepEqual(normalizeGallerySubjectIds([3, 0, -1, 3, 2, 1.5, 2]), [3, 2]);
});

test("gallery image batch failures propagate", async () => {
  await assert.rejects(
    () => queryGalleryImageBatches([1], async () => { throw new Error("d1 gallery query failed"); }),
    /d1 gallery query failed/,
  );
});

test("gallery image rows keep deterministic multi-image ordering after merging batches", () => {
  const grouped = groupGalleryImageRows([
    { subjectId: 2, sortOrder: 1, id: 8, thumbnail: "two-b" },
    { subjectId: 1, sortOrder: 2, id: 4, thumbnail: "one-c" },
    { subjectId: 1, sortOrder: 0, id: 3, thumbnail: "one-a" },
    { subjectId: 1, sortOrder: 0, id: 2, thumbnail: "one-a-before" },
    { subjectId: 2, sortOrder: 0, id: 7, thumbnail: "two-a" },
  ]);
  assert.deepEqual([...grouped.keys()], [1, 2]);
  assert.deepEqual(grouped.get(1)?.map((row) => row.thumbnail), ["one-a-before", "one-a", "one-c"]);
  assert.deepEqual(grouped.get(2)?.map((row) => row.thumbnail), ["two-a", "two-b"]);
});
