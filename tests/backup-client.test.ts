import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArchiveSummary } from "../app/lib/backup-client";
// @ts-expect-error Node's TypeScript loader requires an explicit extension.
import { BackupApiError, archiveDownloadLinks, archiveDownloadUrl, backupFailure, completeArchive, completeRestore, inspectBackupZipParts, requestBackup, validateBackupZipEntries } from "../app/lib/backup-client.ts";

const snapshot = { format: "yuexiaji-collection-backup", subjects: [{ title: "导入前的收藏" }] };
const responseFrom = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });
const archive = (processedAssets = 0, status: ArchiveSummary["status"] = "pending"): ArchiveSummary => ({
  id: "backup-1", createdAt: "2026-11-24T00:00:00Z", kind: "manual", status,
  counts: { subjects: 2, images: 2, storageLinks: 1, devices: 1, settings: 1, schedules: 0 },
  assetCount: 2, assetBytes: 100, processedAssets, totalAssets: 2, downloadParts: status === "complete" ? 1 : 0,
});

test("an HTTP 500 import retains the pre-import snapshot and confirms rollback only from the response", async () => {
  const payload = { ok: false, error: "收藏写入失败", preImportBackup: snapshot, rolledBack: true };
  await assert.rejects(requestBackup("/import", undefined, responseFrom(payload, 500)), (error: unknown) => {
    assert.ok(error instanceof BackupApiError);
    assert.equal(error.status, 500);
    assert.deepEqual(error.payload, payload);
    const failure = backupFailure(error, "import");
    assert.deepEqual(failure.preImportBackup, snapshot);
    assert.equal(failure.rolledBack, true);
    assert.match(failure.message, /当前数据已保留/);
    return true;
  });
});

test("legacy partial-import errors keep their recovery snapshot without claiming rollback", async () => {
  const payload = { ok: false, errors: [{ title: "收藏 A", error: "写入失败" }], preImportBackup: snapshot };
  await assert.rejects(requestBackup("/import", undefined, responseFrom(payload, 500)), (error: unknown) => {
    const failure = backupFailure(error, "import");
    assert.deepEqual(failure.preImportBackup, snapshot);
    assert.equal(failure.rolledBack, false);
    assert.match(failure.message, /收藏 A：写入失败/);
    assert.match(failure.message, /下载保存并核对/);
    assert.doesNotMatch(failure.message, /当前数据已保留|已回滚/);
    return true;
  });
});

test("restore errors preserve the pre-restore backup ID for download", () => {
  const failure = backupFailure(new BackupApiError("恢复未完成", 500, {
    preRestoreBackupId: "before-restore-123", rolledBack: true,
  }), "restore");
  assert.equal(failure.preRestoreBackupId, "before-restore-123");
  assert.match(failure.message, /本次恢复未生效/);
});

test("a lost mutation response never claims success or a rollback", () => {
  const failure = backupFailure(new Error("Failed to fetch"), "restore");
  assert.equal(failure.rolledBack, false);
  assert.equal(failure.preRestoreBackupId, null);
  assert.match(failure.message, /尚未确认操作结果/);
  assert.doesNotMatch(failure.message, /已保留|已回滚|恢复完成/);
});

test("an unsuccessful JSON payload is rejected even when HTTP reports success", async () => {
  await assert.rejects(requestBackup("/import", undefined, responseFrom({ ok: false, error: "事务失败", preImportBackup: snapshot })), (error: unknown) => {
    assert.ok(error instanceof BackupApiError);
    assert.deepEqual(error.payload.preImportBackup, snapshot);
    return true;
  });
});

test("an unexpected HTML login page cannot become a successful backup result", async () => {
  await assert.rejects(requestBackup("/backup", undefined, async () => new Response("<html>登录</html>")), /未收到有效/);
});

test("pending backups advance in order until complete without extra requests", async () => {
  const progress: number[] = [];
  let calls = 0;
  const result = await completeArchive(archive(), async (id: string) => {
    assert.equal(id, "backup-1");
    calls += 1;
    return archive(calls, calls === 2 ? "complete" : "pending");
  }, (next: ArchiveSummary) => progress.push(next.processedAssets));
  assert.equal(result.status, "complete");
  assert.equal(calls, 2);
  assert.deepEqual(progress, [0, 1, 2]);
});

test("a failed backup request is not silently retried", async () => {
  let calls = 0;
  await assert.rejects(completeArchive(archive(), async () => {
    calls += 1;
    throw new Error("connection lost");
  }, () => {}), /connection lost/);
  assert.equal(calls, 1);
});

test("a stalled backup stops after three responses without progress", async () => {
  let calls = 0;
  await assert.rejects(completeArchive(archive(), async () => {
    calls += 1;
    return archive();
  }, () => {}), /进度暂未推进/);
  assert.equal(calls, 3);
});

test("a backup continuation cannot switch to another archive", async () => {
  await assert.rejects(completeArchive(archive(), async () => ({ ...archive(1), id: "other" }), () => {}), /不一致/);
});

test("a cancelled panel does not start another backup request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(completeArchive(archive(), async () => { calls += 1; return archive(2, "complete"); }, () => {}, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

const hash = "a".repeat(64);
const manifest = { format: "yuexiaji-archive", version: 1, assets: [{ sha256: hash, size: 4 }] };
const entries = [{ name: "backup.json", size: 100 }, { name: `assets/${hash}`, size: 4 }];

test("shared image references use one ZIP file without changing the manifest", () => {
  const shared = { ...manifest, assets: [...manifest.assets, { ...manifest.assets[0], urls: ["/second-image"] }] };
  const before = structuredClone(shared);
  const result = validateBackupZipEntries(shared, entries);
  assert.equal(result.size, 1);
  assert.equal(result.get(hash), entries[1]);
  assert.deepEqual(shared, before);
});

test("ZIP uploads reject missing, unrelated and inconsistent image files before starting", () => {
  assert.throws(() => validateBackupZipEntries(manifest, entries.slice(0, 1)), /缺少/);
  assert.throws(() => validateBackupZipEntries(manifest, [...entries, { name: `assets/${"b".repeat(64)}`, size: 4 }]), /清单之外/);
  assert.throws(() => validateBackupZipEntries(manifest, [entries[0], { ...entries[1], size: 5 }]), /大小与清单不一致/);
  assert.throws(() => validateBackupZipEntries(manifest, [...entries, entries[1]]), /重复图片/);
  assert.throws(() => validateBackupZipEntries(manifest, [entries[1]]), /缺少/);
  assert.throws(() => validateBackupZipEntries({ ...manifest, assets: [{ sha256: hash, size: 9 * 1024 * 1024 }] }, entries), /清单不完整/);
});

test("a data-only full backup remains valid when its asset list is empty", () => {
  assert.equal(validateBackupZipEntries({ ...manifest, assets: [] }, [entries[0]]).size, 0);
});

test("archive download URLs preserve the selected identifier as one query value", () => {
  assert.equal(archiveDownloadUrl("id &format=json"), "/api/backup/archive?id=id%20%26format%3Djson&format=zip");
  assert.equal(archiveDownloadUrl("id &format=json", "zip", 2), "/api/backup/archive?id=id%20%26format%3Djson&format=zip&part=2");
  assert.throws(() => archiveDownloadUrl("id", "zip", 0), /编号无效/);
});

test("multipart downloads expose every part and unknown counts never imply one complete ZIP", () => {
  const links = archiveDownloadLinks({ id: "backup-1", downloadParts: 3 });
  assert.deepEqual(links.map((link: { part: number }) => link.part), [1, 2, 3]);
  assert.ok(links.every((link: { href: string; part: number }) => link.href.endsWith(`&part=${link.part}`)));
  assert.equal(archiveDownloadLinks({ id: "backup-1", downloadParts: 1 })[0].href, archiveDownloadUrl("backup-1"));
  assert.deepEqual(archiveDownloadLinks({ id: "backup-1", downloadParts: 0 }), []);
  assert.deepEqual(archiveDownloadLinks({ id: "backup-1", downloadParts: Number.NaN }), []);
});

const secondHash = "b".repeat(64);
function zipPartsFixture() {
  const fullManifest = { ...manifest, assets: [...manifest.assets, { sha256: secondHash, size: 7 }] };
  const text = JSON.stringify(fullManifest);
  const files = [new Blob(["first ZIP"]), new Blob(["second ZIP"])];
  const texts = new Map(files.map((file) => [file, text]));
  const directories = new Map([
    [files[0], [{ name: "backup.json", size: text.length }, { name: `assets/${hash}`, size: 4 }]],
    [files[1], [{ name: "backup.json", size: text.length }, { name: `assets/${secondHash}`, size: 7 }]],
  ]);
  const reads: Array<{ file: Blob; name: string }> = [];
  const inspect = async (file: Blob) => directories.get(file)!;
  const read = async (file: Blob, entry: { name: string }) => {
    reads.push({ file, name: entry.name });
    assert.equal(entry.name, "backup.json", "inspection must not read image bytes");
    return new Blob([texts.get(file)!]);
  };
  return { files, texts, directories, reads, inspect, read, fullManifest };
}

test("multipart ZIP inspection keeps each image in its source file and reads only manifests", async () => {
  const fixture = zipPartsFixture();
  const result = await inspectBackupZipParts(fixture.files, fixture.inspect, fixture.read);
  assert.deepEqual(result.manifest, fixture.fullManifest);
  assert.equal(result.assets.size, 2);
  assert.equal(result.assets.get(hash)!.file, fixture.files[0]);
  assert.equal(result.assets.get(secondHash)!.file, fixture.files[1]);
  assert.equal(result.assets.get(secondHash)!.entry.name, `assets/${secondHash}`);
  assert.equal(fixture.reads.length, 2);
});

test("multipart uploads reject a missing part before an upload record can be created", async () => {
  const fixture = zipPartsFixture();
  await assert.rejects(inspectBackupZipParts([fixture.files[0]], fixture.inspect, fixture.read), /缺少/);
});

test("different manifest bytes are rejected even if the JSON data is equivalent", async () => {
  const fixture = zipPartsFixture();
  fixture.texts.set(fixture.files[1], JSON.stringify(fixture.fullManifest, null, 2));
  await assert.rejects(inspectBackupZipParts(fixture.files, fixture.inspect, fixture.read), /清单不一致/);
});

test("image files cannot appear in more than one selected ZIP part", async () => {
  const fixture = zipPartsFixture();
  fixture.directories.get(fixture.files[1])!.push({ name: `assets/${hash}`, size: 4 });
  await assert.rejects(inspectBackupZipParts(fixture.files, fixture.inspect, fixture.read), /重复图片/);
});

test("every selected part needs exactly one manifest", async () => {
  const fixture = zipPartsFixture();
  fixture.directories.set(fixture.files[1], [{ name: `assets/${secondHash}`, size: 7 }]);
  await assert.rejects(inspectBackupZipParts(fixture.files, fixture.inspect, fixture.read), /每个备份分包/);
});

test("single ZIP backups still use the same inventory validation", async () => {
  const file = new Blob(["single ZIP"]);
  const result = await inspectBackupZipParts([file], async () => entries, async () => new Blob([JSON.stringify(manifest)]));
  assert.equal(result.assets.size, 1);
  assert.equal(result.assets.get(hash)!.file, file);
  assert.deepEqual(result.manifest, manifest);
});

test("25,000 assets complete through backup and a resumed restoration in batches of eight", async () => {
  const total = 25000;
  let processed = 0;
  await completeArchive({ ...archive(), totalAssets: total }, async () => {
    processed = Math.min(total, processed + 8);
    return { ...archive(processed, processed === total ? "complete" : "pending"), totalAssets: total };
  }, () => {});
  assert.equal(processed, total);
  const initial = { ...archive(), totalAssets: total };
  let checkpoint = "";
  let calls = 0;
  await assert.rejects(completeRestore(undefined, async () => {
    if (++calls === 2) throw new Error("interrupted");
    return { preRestoreBackupId: initial.id, needsPreparation: true, backup: initial };
  }, async () => {}, id => { checkpoint = id; }, () => {}, new AbortController().signal), /interrupted/);
  processed = 0;
  await completeRestore(checkpoint, async id => {
    assert.equal(id, initial.id);
    processed = Math.min(total, processed + 8);
    return processed === total ? { ok: true, restored: {}, preRestoreBackupId: id } :
      { needsMore: true, preRestoreBackupId: id, processedAssets: processed, totalAssets: total };
  }, async () => assert.fail(), () => assert.fail(), () => {}, new AbortController().signal);
  assert.equal(processed, total);
});
