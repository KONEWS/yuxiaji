import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { mediaStorageLinks, userSubjectImages, userSubjects } from "../../../../db/schema";
import { guardBrowserApi } from "../../../lib/admin-auth";
import { buildCollectionBackup } from "../../../lib/collection-backup-store";
import {
  CollectionBackupError,
  parseCollectionBackup,
  planCollectionImport,
  type BackupSubject,
} from "../../../lib/collection-backup";
import { getCurrentUser } from "../../../lib/current-user";
import { sanitizeGalleryImages } from "../../../lib/gallery-images";
import { sanitizeMediaStorageLink } from "../../../lib/media-storage-links";
import { sanitizeSubject } from "../../media/route";

/**
 * 收藏导入（备份组件，独立路由）。
 *
 * 安全与可逆约定：
 * - 只接受管理员 Session + CSRF（guardBrowserApi），且只写收藏三张表。
 * - mode=preview 只算计划、不写库；mode=import 必须带 confirmed=true，
 *   且先算出导入前的当前导出（preImportBackup）再写库，写完后
 *   把这份导入前快照原样返回，导入后发现不对可以再用它导回去。
 * - 默认是合并：已存在按 id /（类型+外部 subjectId+标题）更新，
 *   其余新增；绝不因为导入文件里没有某条记录就删除库内记录。
 * - 导入不是跨全部条目的原子事务：某条写失败时停在该条，
 *   之前已写的条目不会自动回滚，响应里会如实返回已写条数
 *   与 preImportBackup，靠重新导入这份快照恢复。
 * - 画廊与存储关联只删 DB 行、不删 R2 原文件：备份里仍引用
 *   的图片地址在重新插入后继续可用，避免误删展示图。
 */
export async function POST(request: Request) {
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
  const key = getCurrentUser();
  try {
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "请求体必须是有效 JSON" }, { status: 400 });
    }

    let backup;
    try {
      backup = parseCollectionBackup(body.backup);
    } catch (error) {
      if (error instanceof CollectionBackupError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const db = getDb();
    const existingRows = await db
      .select({ id: userSubjects.id, type: userSubjects.type, subjectId: userSubjects.subjectId, title: userSubjects.title })
      .from(userSubjects)
      .where(eq(userSubjects.userKey, key))
      .orderBy(asc(userSubjects.id));
    const plan = planCollectionImport(existingRows, backup);

    if (body.mode !== "import") {
      return Response.json(
        { ok: true, mode: "preview", plan },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (body.confirmed !== true) {
      return Response.json(
        { error: "导入前请先预览并确认", plan },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }

    // 先备当前数据，再写库。
    const preImportBackup = await buildCollectionBackup(db, key);
    let created = 0;
    let updated = 0;
    let skippedLinks = 0;
    const errors: Array<{ title: string; error: string }> = [];

    // 预览与备份条目一一对应，按下标取计划，不按导出 id 查表，
    // 避免无 id 或重复 id 的手工备份文件把计划张冠李戴。
    for (let index = 0; index < backup.subjects.length; index += 1) {
      const subject = backup.subjects[index];
      const item = plan.items[index];
      const targetId = item?.existingId ?? null;
      try {
        const target = await writeSubject(db, key, subject, targetId);
        if (targetId === null) created += 1;
        else updated += 1;
        skippedLinks += await writeAttachments(db, key, target, subject);
      } catch (error) {
        errors.push({
          title: subject.title,
          error: error instanceof Error ? error.message : "写入失败",
        });
        break;
      }
    }

    return Response.json(
      {
        ok: errors.length === 0,
        mode: "import",
        created,
        updated,
        skippedLinks,
        errors,
        preImportBackup,
      },
      { status: errors.length ? 500 : 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "导入收藏失败" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

type Database = ReturnType<typeof getDb>;

function toBrowserBody(subject: BackupSubject): Record<string, unknown> {
  return {
    mediaType: subject.type,
    subjectId: subject.subjectId ?? undefined,
    title: subject.title,
    jp: subject.jp,
    note: subject.note,
    progress: subject.progress,
    total: subject.total,
    status: subject.status,
    kind: subject.kind,
    score: subject.score,
    next: subject.next,
    image: subject.image,
    globalScore: subject.globalScore,
    source: subject.source,
    collection: subject.collection,
    tags: subject.tags,
    musicAlbum: subject.musicAlbum,
    musicArtist: subject.musicArtist,
    lyricist: subject.lyricist,
    composer: subject.composer,
    animeSong: subject.animeSong,
    visualSubtype: subject.visualSubtype,
    videoSubtype: subject.videoSubtype,
    thumbnail: subject.thumbnail,
    sourceUrl: subject.sourceUrl,
    pixivPid: subject.pixivPid,
    author: subject.author,
    twitterSource: subject.twitterSource,
    metadata: subject.metadata,
  };
}

async function writeSubject(
  db: Database,
  userKey: string,
  subject: BackupSubject,
  targetId: number | null,
): Promise<number> {
  const sanitized = sanitizeSubject(toBrowserBody(subject));
  if (targetId !== null) {
    await db
      .update(userSubjects)
      .set(sanitized)
      .where(and(eq(userSubjects.id, targetId), eq(userSubjects.userKey, userKey)));
    return targetId;
  }
  const [created] = await db
    .insert(userSubjects)
    .values({ ...sanitized, userKey })
    .returning({ id: userSubjects.id });
  if (!created) throw new Error("创建收藏失败");
  return created.id;
}

async function writeAttachments(
  db: Database,
  userKey: string,
  targetId: number,
  subject: BackupSubject,
): Promise<number> {
  const now = new Date();
  await db
    .delete(userSubjectImages)
    .where(and(eq(userSubjectImages.userKey, userKey), eq(userSubjectImages.subjectId, targetId)));
  await db
    .delete(mediaStorageLinks)
    .where(and(eq(mediaStorageLinks.userKey, userKey), eq(mediaStorageLinks.mediaId, targetId)));

  const images = sanitizeGalleryImages(subject.images) ?? [];
  for (const image of images) {
    await db.insert(userSubjectImages).values({
      userKey,
      subjectId: targetId,
      thumbnail: image.thumbnail,
      sourceUrl: image.sourceUrl,
      imageHash: image.imageHash,
      sortOrder: image.sortOrder,
      isCover: image.isCover,
      width: image.width,
      height: image.height,
      mime: image.mime,
      createdAt: now,
      updatedAt: now,
    });
  }

  let skipped = 0;
  let primaryUsed = false;
  for (const link of subject.storageLinks) {
    try {
      const sanitized = sanitizeMediaStorageLink({
        ...link,
        verifiedAt: link.verifiedAtMs,
      });
      // 备份文件手工改动可能导致多个主链接，库内主链接唯一：
      // 只保留第一条主链接，其余降为非主链接。
      const isPrimary = sanitized.isPrimary && !primaryUsed;
      if (sanitized.isPrimary) primaryUsed = true;
      await db.insert(mediaStorageLinks).values({
        ...sanitized,
        verifiedAt: sanitized.verifiedAt === null ? null : new Date(sanitized.verifiedAt),
        userKey,
        mediaId: targetId,
        isPrimary,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      skipped += 1;
    }
  }
  return skipped;
}
