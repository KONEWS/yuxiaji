import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTION_BACKUP_FORMAT,
  COLLECTION_BACKUP_VERSION,
  parseCollectionBackup,
  planCollectionImport,
} from "../app/lib/collection-backup.ts";
import {
  BACKUP_PROVIDERS,
  getBackupProvider,
  isBackupComponentEnabledValue,
  uploadBackupToProvider,
} from "../app/lib/backup-providers.ts";

function validBackup() {
  return {
    format: COLLECTION_BACKUP_FORMAT,
    version: COLLECTION_BACKUP_VERSION,
    exportedAt: "2026-11-03T00:00:00.000Z",
    counts: { subjects: 2, images: 1, storageLinks: 1 },
    subjects: [
      {
        id: 10, type: "anime", subjectId: 100, title: "测试动画", jp: "", note: "",
        progress: 3, total: 12, status: "watching", kind: "coral", score: 9,
        next: null, image: null, globalScore: null, source: "bangumi",
        collection: "", tags: ["百合"], musicAlbum: "", musicArtist: "",
        lyricist: "", composer: "", animeSong: false, visualSubtype: "other",
        videoSubtype: "other", thumbnail: "", sourceUrl: "", pixivPid: "",
        author: "", twitterSource: "", metadata: { year: 2024 },
        updatedAtMs: 1700000000000, images: [], storageLinks: [],
      },
      {
        id: 11, type: "music", subjectId: null, title: "测试音乐", jp: "", note: "",
        progress: 0, total: 1, status: "library", kind: "coral", score: null,
        next: null, image: null, globalScore: null, source: "manual",
        collection: "", tags: [], musicAlbum: "专辑", musicArtist: "歌手",
        lyricist: "", composer: "", animeSong: false, visualSubtype: "other",
        videoSubtype: "other", thumbnail: "", sourceUrl: "", pixivPid: "",
        author: "", twitterSource: "", metadata: {},
        updatedAtMs: 1700000000000,
        images: [{ thumbnail: "https://example.com/cover.jpg", sourceUrl: "", imageHash: "", sortOrder: 0, isCover: true, width: null, height: null, mime: "" }],
        storageLinks: [{ provider: "mega", label: "", url: "https://example.com/share", path: "/archive", isPrimary: true, note: "", state: "linked", operationKey: "", objectCount: null, totalBytes: null, manifestSha256: "", verifiedAtMs: null }],
      },
    ],
  };
}

test("parseCollectionBackup 接受合法的收藏备份并核对条数", () => {
  const parsed = parseCollectionBackup(validBackup());
  assert.equal(parsed.counts.subjects, 2);
  assert.equal(parsed.counts.images, 1);
  assert.equal(parsed.counts.storageLinks, 1);
});

test("parseCollectionBackup 拒绝敏感表与凭据字段", () => {
  assert.throws(() => parseCollectionBackup({ ...validBackup(), admin_account: [] }), /不允许包含/);
  const withToken = validBackup();
  withToken.subjects[0].metadata = { apiKey: "secret" };
  assert.throws(() => parseCollectionBackup(withToken), /凭据字段/);
});

test("parseCollectionBackup 拒绝版本与条数不一致", () => {
  assert.throws(() => parseCollectionBackup({ ...validBackup(), version: 99 }), /版本/);
  const wrongCounts = validBackup();
  wrongCounts.counts.subjects = 99;
  assert.throws(() => parseCollectionBackup(wrongCounts), /条数不一致/);
});

test("planCollectionImport 先按 id、再按类型加外部 id 加标题匹配", () => {
  const backup = parseCollectionBackup(validBackup());
  const existing = [
    { id: 10, type: "anime", subjectId: 100, title: "测试动画" },
    { id: 99, type: "music", subjectId: null, title: "其他" },
  ];
  const plan = planCollectionImport(existing, backup);
  assert.equal(plan.update, 1);
  assert.equal(plan.create, 1);
  assert.equal(plan.items[0].match, "id");
  assert.equal(plan.items[1].action, "create");
});

test("网盘注册表目前只有百度占位，且上传明确返回未接通", async () => {
  assert.equal(BACKUP_PROVIDERS.length, 1);
  assert.equal(getBackupProvider("baidu")?.ready, false);
  const result = await uploadBackupToProvider("baidu", { name: "x.json", text: "{}" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /尚未/);
  assert.equal(isBackupComponentEnabledValue("0"), false);
  assert.equal(isBackupComponentEnabledValue(undefined), true);
});
