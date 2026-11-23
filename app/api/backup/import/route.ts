import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { mediaStorageLinks, userSubjectImages, userSubjects } from "../../../../db/schema";
import { guardBrowserApi } from "../../../lib/admin-auth";
import { buildCollectionBackup } from "../../../lib/collection-backup-store";
import {
  CollectionBackupError, parseCollectionBackup, planCollectionImport,
  type BackupSubject, type CollectionBackup,
} from "../../../lib/collection-backup";
import { getCurrentUser } from "../../../lib/current-user";
import { sanitizeGalleryImages } from "../../../lib/gallery-images";
import { MediaStorageLinkValidationError, sanitizeMediaStorageLink } from "../../../lib/media-storage-links";
import {
  COLLECTION_BACKUP_TABLE_NAMES, exportCollectionSnapshot, siteBackupFingerprint,
  siteBackupGuardStatements, siteBackupWriteError, SiteBackupError, type SiteBackup,
} from "../../../lib/site-backup-data";
import { sanitizeSubject } from "../../media/route";

const headers = { "cache-control": "no-store" };

async function collectionRevision(snapshot: SiteBackup) {
  return siteBackupFingerprint({
    ...snapshot,
    tables: { ...snapshot.tables, user_devices: [], user_state: [], anime_airing_schedule: [] },
    counts: { ...snapshot.counts, devices: 0, settings: 0, schedules: 0 },
  });
}

/** Legacy JSON import: validate everything, then merge in ONE D1 transaction. */
export async function POST(request: Request) {
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
  const key = getCurrentUser();
  let preImportBackup: CollectionBackup | undefined;
  try {
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "请求体必须是有效 JSON 对象", rolledBack: true }, { status: 400, headers });
    }
    const backup = parseCollectionBackup(body.backup);
    // Validate before the transaction; never discard a malformed attachment
    // after its old associations have already been removed.
    const prepared = backup.subjects.map((subject) => {
      const sanitizedImages = sanitizeGalleryImages(subject.images) ?? [];
      if (sanitizedImages.length !== subject.images.length) throw new CollectionBackupError(`《${subject.title}》的画廊图片存在重复或无效项`);
      // The backup parser already checked every source line. Preserve its raw
      // text instead of applying the ordinary form input's whitespace cleanup.
      const images = sanitizedImages.map((image, index) => ({ ...image, sourceUrl: subject.images[index].sourceUrl }));
      const links = subject.storageLinks.map((link) => sanitizeMediaStorageLink({ ...link, verifiedAt: link.verifiedAtMs }));
      if (links.filter((link) => link.isPrimary).length > 1) throw new CollectionBackupError(`《${subject.title}》存在多个主存储关联`);
      return { subject: { ...sanitizeSubject(toBrowserBody(subject)), sourceUrl: subject.sourceUrl }, images, links };
    });

    const db = getDb();
    const current = await exportCollectionSnapshot(db.$client, key);
    preImportBackup = await buildCollectionBackup(db, key, current);
    const plan = planCollectionImport(current.tables.user_subjects.map((row) => ({
      id: Number(row.id), type: String(row.type), subjectId: row.subject_id === null ? null : Number(row.subject_id), title: String(row.title),
    })), backup);
    const revision = await collectionRevision(current);
    if (body.mode !== "import") return Response.json({ ok: true, mode: "preview", plan, revision }, { headers });
    if (body.confirmed !== true) return Response.json({ error: "导入前请先预览并确认", plan, preImportBackup, rolledBack: true }, { status: 400, headers });
    if (body.expectedRevision !== undefined && body.expectedRevision !== revision) {
      return Response.json({ error: "预览后收藏已更新，请重新预览后再导入。", code: "backup_conflict", rolledBack: true, preImportBackup }, { status: 409, headers });
    }

    const statements = siteBackupGuardStatements(db.$client, key, current, COLLECTION_BACKUP_TABLE_NAMES);
    let nextId = 0;
    if (plan.create) {
      const allocationSql = "SELECT max(coalesce((SELECT max(id) FROM user_subjects),0),coalesce((SELECT seq FROM sqlite_sequence WHERE name='user_subjects'),0)) AS id";
      const row = await db.$client.prepare(allocationSql).first<{ id: number }>();
      nextId = Number(row?.id ?? 0);
      if (!Number.isSafeInteger(nextId + plan.create)) throw new CollectionBackupError("收藏 ID 已超过可安全分配的范围");
      // Guard the global maximum too: another owner may create a new row
      // between this read and the write transaction.
      statements.push(db.$client.prepare(`SELECT CASE WHEN (${allocationSql}) = ? THEN 1 ELSE json('site_backup_conflict') END`).bind(nextId));
    }
    const append = (query: { toSQL(): { sql: string; params: unknown[] } }) => {
      const compiled = query.toSQL();
      statements.push(db.$client.prepare(compiled.sql).bind(...compiled.params));
    };
    const now = new Date();
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index];
      const existingId = plan.items[index].existingId;
      const targetId = existingId ?? ++nextId;
      if (existingId === null) append(db.insert(userSubjects).values({ ...item.subject, id: targetId, userKey: key }));
      else append(db.update(userSubjects).set(item.subject).where(and(eq(userSubjects.id, targetId), eq(userSubjects.userKey, key))));
      append(db.delete(userSubjectImages).where(and(eq(userSubjectImages.userKey, key), eq(userSubjectImages.subjectId, targetId))));
      append(db.delete(mediaStorageLinks).where(and(eq(mediaStorageLinks.userKey, key), eq(mediaStorageLinks.mediaId, targetId))));
      for (const image of item.images) append(db.insert(userSubjectImages).values({
        userKey: key, subjectId: targetId, thumbnail: image.thumbnail, sourceUrl: image.sourceUrl,
        imageHash: image.imageHash, sortOrder: image.sortOrder, isCover: image.isCover,
        width: image.width, height: image.height, mime: image.mime, createdAt: now, updatedAt: now,
      }));
      for (const link of item.links) append(db.insert(mediaStorageLinks).values({
        ...link, verifiedAt: link.verifiedAt === null ? null : new Date(link.verifiedAt),
        userKey: key, mediaId: targetId, createdAt: now, updatedAt: now,
      }));
    }
    try { await db.$client.batch(statements); } catch (error) {
      const failure = siteBackupWriteError(error);
      return Response.json({
        ok: false, mode: "import", error: failure.message, code: failure.code, rolledBack: failure.rolledBack,
        created: failure.rolledBack ? 0 : null, updated: failure.rolledBack ? 0 : null, skippedLinks: 0,
        errors: [{ error: failure.message }], preImportBackup,
      }, { status: failure.status, headers });
    }
    return Response.json({ ok: true, mode: "import", created: plan.create, updated: plan.update, skippedLinks: 0, errors: [], preImportBackup }, { headers });
  } catch (error) {
    const validation = error instanceof CollectionBackupError || error instanceof MediaStorageLinkValidationError;
    return Response.json({
      ok: false, error: error instanceof Error ? error.message : "导入收藏失败", rolledBack: true,
      ...(error instanceof SiteBackupError ? { code: error.code } : {}),
      ...(preImportBackup ? { preImportBackup } : {}),
    }, { status: validation ? 400 : error instanceof SiteBackupError ? error.status : 500, headers });
  }
}

function toBrowserBody(subject: BackupSubject): Record<string, unknown> {
  return {
    mediaType: subject.type, subjectId: subject.subjectId ?? undefined, title: subject.title, jp: subject.jp,
    note: subject.note, progress: subject.progress, total: subject.total, status: subject.status, kind: subject.kind,
    score: subject.score, next: subject.next, image: subject.image, globalScore: subject.globalScore, source: subject.source,
    collection: subject.collection, tags: subject.tags, musicAlbum: subject.musicAlbum, musicArtist: subject.musicArtist,
    lyricist: subject.lyricist, composer: subject.composer, animeSong: subject.animeSong, visualSubtype: subject.visualSubtype,
    videoSubtype: subject.videoSubtype, thumbnail: subject.thumbnail, sourceUrl: subject.sourceUrl, pixivPid: subject.pixivPid,
    author: subject.author, twitterSource: subject.twitterSource, metadata: subject.metadata,
  };
}
