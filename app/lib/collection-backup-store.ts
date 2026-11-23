import { asc, eq, getTableColumns } from "drizzle-orm";
import { getDb } from "../../db";
import { mediaStorageLinks, userSubjectImages, userSubjects } from "../../db/schema";
import type { SiteBackup } from "./site-backup-data";
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
  snapshot?: SiteBackup,
): Promise<CollectionBackup> {
  const tables = [userSubjects, userSubjectImages, mediaStorageLinks] as const;
  // A single D1 read transaction prevents a concurrent edit from producing
  // parent rows and attachments from different moments.
  const queries = [
    db.select().from(userSubjects).where(eq(userSubjects.userKey, userKey)).orderBy(asc(userSubjects.id)),
    db.select().from(userSubjectImages).where(eq(userSubjectImages.userKey, userKey)).orderBy(asc(userSubjectImages.subjectId), asc(userSubjectImages.sortOrder), asc(userSubjectImages.id)),
    db.select().from(mediaStorageLinks).where(eq(mediaStorageLinks.userKey, userKey)).orderBy(asc(mediaStorageLinks.mediaId), asc(mediaStorageLinks.id)),
  ];
  const rawRows = snapshot
    ? [snapshot.tables.user_subjects, snapshot.tables.user_subject_images, snapshot.tables.media_storage_links]
    : (await db.$client.batch<Record<string, unknown>>(queries.map((query) => {
      const compiled = query.toSQL();
      return db.$client.prepare(compiled.sql).bind(...compiled.params);
    }))).map((result) => {
      if (!result.success) throw new Error("读取收藏备份失败");
      return result.results;
    });
  const decoded = tables.map((table, index) => rawRows[index].map((raw) => Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key, column.name === "user_key" ? userKey : raw[column.name] === null ? null : column.mapFromDriverValue(raw[column.name] as never),
    ]),
  )));
  const rows = decoded[0] as (typeof userSubjects.$inferSelect)[];
  const imageMap = new Map<number, (typeof userSubjectImages.$inferSelect)[]>();
  for (const image of decoded[1] as (typeof userSubjectImages.$inferSelect)[]) {
    imageMap.set(image.subjectId, [...(imageMap.get(image.subjectId) ?? []), image]);
  }
  for (const images of imageMap.values()) images.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const linkMap = new Map<number, (typeof mediaStorageLinks.$inferSelect)[]>();
  for (const link of decoded[2] as (typeof mediaStorageLinks.$inferSelect)[]) {
    linkMap.set(link.mediaId, [...(linkMap.get(link.mediaId) ?? []), link]);
  }

  const subjects: BackupSubject[] = rows.map((row) => {
    const tags: string[] = [];
    for (const source of [row.tags, row.characterTags]) {
      try {
        const parsed = JSON.parse(source || "[]");
        if (Array.isArray(parsed)) tags.push(...parsed.map(String).filter(Boolean));
      } catch {
        // Legacy tags may be comma-separated instead of JSON.
        tags.push(...(source || "").split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean));
      }
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
      tags: [...new Set(tags)],
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
    exportedAt: snapshot?.exportedAt ?? new Date().toISOString(),
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
