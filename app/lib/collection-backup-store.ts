import { asc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { userSubjects } from "../../db/schema";
import { galleryImagesBySubjectIds } from "./gallery-images";
import { mediaStorageLinksByMediaIds } from "./media-storage-link-store";
import {
  COLLECTION_BACKUP_FORMAT,
  COLLECTION_BACKUP_VERSION,
  parseCollectionBackup,
  type BackupSubject,
  type CollectionBackup,
} from "./collection-backup";

type Database = ReturnType<typeof getDb>;

/**
 * 把当前库内收藏读成导出格式。导出路由与导入前的
 * “先备当前数据”共用这一份实现，避免两处读法不一致。
 * 只读收藏三张表，不碰凭据、会话、账户表。
 */
export async function buildCollectionBackup(
  db: Database,
  userKey: string,
): Promise<CollectionBackup> {
  const rows = await db
    .select()
    .from(userSubjects)
    .where(eq(userSubjects.userKey, userKey))
    .orderBy(asc(userSubjects.id));
  const ids = rows.map((row) => row.id);
  const imageMap = await galleryImagesBySubjectIds(db, userKey, ids);
  const linkMap = await mediaStorageLinksByMediaIds(db, userKey, ids);

  const subjects: BackupSubject[] = rows.map((row) => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags || "[]");
      if (Array.isArray(parsed)) tags = parsed.map(String).filter(Boolean);
    } catch {
      tags = [];
    }
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
    return {
      id: row.id,
      type: row.type,
      subjectId: row.subjectId,
      title: row.title,
      jp: row.jp,
      note: row.note,
      progress: row.progress,
      total: row.total,
      status: row.status,
      kind: row.kind,
      score: row.score,
      next: row.next,
      image: row.image,
      globalScore: row.globalScore,
      source: row.source,
      collection: row.collection,
      tags,
      musicAlbum: row.musicAlbum,
      musicArtist: row.musicArtist,
      lyricist: row.lyricist,
      composer: row.composer,
      animeSong: Boolean(row.animeSong),
      visualSubtype: row.visualSubtype,
      videoSubtype: row.videoSubtype,
      thumbnail: row.thumbnail,
      sourceUrl: row.sourceUrl,
      pixivPid: row.pixivPid,
      author: row.author,
      twitterSource: row.twitterSource,
      metadata,
      updatedAtMs: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
      images: (imageMap.get(row.id) ?? []).map((image) => ({
        thumbnail: image.thumbnail,
        sourceUrl: image.sourceUrl,
        imageHash: image.imageHash,
        sortOrder: image.sortOrder,
        isCover: Boolean(image.isCover),
        width: image.width,
        height: image.height,
        mime: image.mime,
      })),
      storageLinks: (linkMap.get(row.id) ?? []).map((link) => ({
        provider: link.provider,
        label: link.label,
        url: link.url,
        path: link.path,
        isPrimary: Boolean(link.isPrimary),
        note: link.note,
        state: link.state,
        operationKey: link.operationKey,
        objectCount: link.objectCount,
        totalBytes: link.totalBytes,
        manifestSha256: link.manifestSha256,
        verifiedAtMs: link.verifiedAt === null ? null : Number(link.verifiedAt),
      })),
    };
  });

  const raw: CollectionBackup = {
    format: COLLECTION_BACKUP_FORMAT,
    version: COLLECTION_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      subjects: subjects.length,
      images: subjects.reduce((sum, subject) => sum + subject.images.length, 0),
      storageLinks: subjects.reduce((sum, subject) => sum + subject.storageLinks.length, 0),
    },
    subjects,
  };
  // 导出文件必须能被同一个导入校验接受，否则不输出。
  return parseCollectionBackup(raw);
}
