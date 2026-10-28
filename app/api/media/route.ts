import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { userSubjectImages, userSubjects } from "../../../db/schema";
import { normalizeMediaSource } from "../../lib/media-source";
import { getCurrentUser } from "../../lib/current-user";
import { normalizeMediaMetadata, normalizeVideoSubtype, normalizeVisualSubtype } from "../../lib/constants";
import { appendGalleryImage, presentGalleryImage, presentLegacyGalleryImage, deleteGalleryImagesForSubjects, cleanupDeletedGalleryAssets, syncGalleryImages, planGalleryImageSync, MAX_GALLERY_IMAGES, type GalleryImageRow } from "../../lib/gallery-images";
import { mediaStorageLinksByMediaIds } from "../../lib/media-storage-link-store";
import { MediaConflictError, mediaRevision, mediaSnapshotSelection, snapshotGalleryImages, writeMediaSnapshot, type MediaWriteQuery } from "../../lib/media-revisions";
import { finishAgentOperation, reserveAgentOperation } from "../../lib/agent-operations";

const MEDIA_TYPES = ["anime", "movie", "tv", "game", "light_novel", "manga", "music", "visual", "video"] as const;
const STATUSES = ["watching", "wish", "finished", "library", "dropped"] as const;

function normalizeType(value: unknown) {
  if (value === "novel" || value === "book") return "light_novel";
  return MEDIA_TYPES.includes(value as (typeof MEDIA_TYPES)[number]) ? value as string : "anime";
}

function parseText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseTags(value: unknown) {
  const normalize = (tag: unknown) => (typeof tag === "string" || typeof tag === "number") ? String(tag).trim().slice(0, 80) : "";
  const unique = (items: unknown[]) => Array.from(new Set(items.map(normalize).filter(Boolean))).slice(0, 30);
  if (Array.isArray(value)) return unique(value);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? unique(parsed) : [];
  } catch {
    return unique(value.split(/[,，、]/));
  }
}

// `character_tags` predates the unified personal-tag field. Keep the column
// for backward compatibility, but expose and persist one canonical tag list.
export function mergeTags(...values: unknown[]) {
  return parseTags(values.flatMap((value) => parseTags(value)));
}

function parseVisualSubtype(value: unknown) {
  return normalizeVisualSubtype(value as string | null);
}

export function parseMetadata(value: unknown) {
  if (typeof value === "string") {
    try { return normalizeMediaMetadata(JSON.parse(value)); } catch { return normalizeMediaMetadata(); }
  }
  return normalizeMediaMetadata(value);
}

function parseMetadataPatch(value: unknown): Record<string, unknown> {
  const candidate = typeof value === "string"
    ? (() => { try { return JSON.parse(value); } catch { return {}; } })()
    : value;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

export function sanitizeSubject(body: Record<string, unknown>) {
  const type = normalizeType(body.mediaType ?? body.type);
  const total = Number(body.total);
  const progress = Number(body.progress);
  const score = Number(body.score);
  // Empty form values (and explicit null) mean "unset", not a zero score.
  const globalScore = body.globalScore === null || body.globalScore === undefined || typeof body.globalScore === "string" && !body.globalScore.trim()
    ? NaN
    : Number(body.globalScore);
  const safeTotal = ["music", "visual", "movie", "video"].includes(type) ? 1 : Number.isFinite(total) && total > 0 ? Math.floor(total) : type === "game" ? 100 : 12;
  const metadata = normalizeMediaMetadata({
    // Accept both object and legacy JSON-string metadata payloads.
    ...parseMetadata(body.metadata),
    ...(typeof body.platform === "string" ? { platform: body.platform } : {}),
    ...(typeof body.creator === "string" ? { creator: body.creator } : {}),
    ...(typeof body.duration === "string" ? { duration: body.duration } : {}),
  });
  const videoMetadata = type === "video" && !metadata.videoSource
    ? normalizeMediaMetadata({ ...metadata, videoSource: parseText(body.source, 160) && !["manual", "local", "bangumi"].includes(parseText(body.source, 160)) ? parseText(body.source, 160) : undefined })
    : metadata;
  const subjectId = !["music", "visual", "movie", "tv", "video"].includes(type) && Number.isInteger(Number(body.subjectId)) && Number(body.subjectId) > 0
    ? Number(body.subjectId)
    : null;
  return {
    type,
    subjectId,
    title: parseText(body.title, 160) || "未命名条目",
    jp: parseText(body.jp, 160),
    note: parseText(body.note ?? body.description, 2000),
    progress: ["music", "visual", "movie", "video"].includes(type) ? 0 : Number.isFinite(progress) && progress >= 0 ? Math.min(safeTotal, Math.floor(progress)) : 0,
    total: safeTotal,
    status: STATUSES.includes(body.status as (typeof STATUSES)[number]) ? body.status as string : "watching",
    kind: parseText(body.kind, 30) || "coral",
    score: Number.isInteger(score) && score >= 1 && score <= 10 ? score : null,
    next: parseText(body.next, 120) || null,
    image: type === "visual" ? null : parseText(body.image ?? body.cover, 500) || null,
    globalScore: Number.isFinite(globalScore) && globalScore >= 0 && globalScore <= 10 ? globalScore : null,
    source: ["visual", "movie", "tv", "video"].includes(type) ? (type === "visual" && body.source === "local" ? "local" : "manual") : normalizeMediaSource(body.source, subjectId ? "bangumi" : "manual"),
    collection: parseText(body.collection, 120),
    tags: JSON.stringify(mergeTags(body.tags, body.characterTags)),
    musicAlbum: parseText(body.musicAlbum, 160),
    musicArtist: parseText(body.musicArtist, 160),
    lyricist: parseText(body.lyricist, 160),
    composer: parseText(body.composer, 160),
    animeSong: Boolean(body.animeSong),
    visualSubtype: parseVisualSubtype(body.visualSubtype),
    videoSubtype: normalizeVideoSubtype(body.videoSubtype as string | null),
    thumbnail: ["visual", "video"].includes(type) ? parseText(body.thumbnail || body.image, 500) : "",
    sourceUrl: parseText(body.sourceUrl, 1000),
    pixivPid: parseText(body.pixivPid, 80),
    author: parseText(body.author, 160),
    twitterSource: parseText(body.twitterSource, 500),
    characterTags: JSON.stringify([]),
    metadata: JSON.stringify(videoMetadata),
    updatedAt: new Date(),
  };
}

export function presentSubject(row: typeof userSubjects.$inferSelect, imageRows?: GalleryImageRow[], storageLinks?: unknown[]) {
  const metadata = parseMetadata(row.metadata);
  const tags = mergeTags(row.tags, row.characterTags);
  const legacyImage = presentLegacyGalleryImage(row);
  const images = row.type === "visual" ? (imageRows?.length ? imageRows.map(presentGalleryImage) : legacyImage ? [legacyImage] : []) : [];
  return {
    ...row,
    source: ["visual", "movie", "tv", "video"].includes(row.type) ? (row.type === "visual" && row.source === "local" ? "local" : "manual") : normalizeMediaSource(row.source, row.subjectId ? "bangumi" : "manual"),
    tags,
    characterTags: [],
    mediaType: row.type,
    ...(row.type === "video" ? { cover: row.image || undefined, description: row.note, platform: metadata.platform || undefined, creator: metadata.creator || undefined, duration: metadata.duration || undefined } : {}),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : row.updatedAt,
    visualSubtype: row.visualSubtype,
    videoSubtype: row.videoSubtype,
    thumbnail: row.thumbnail || undefined,
    sourceUrl: row.sourceUrl || undefined,
    pixivPid: row.pixivPid || undefined,
    author: row.author || undefined,
    twitterSource: row.twitterSource || undefined,
    metadata,
    ...(row.type === "visual" ? { images } : {}),
    storageLinks: storageLinks || [],
  };
}

/**
 * Convert a stored row back to the public write shape before applying a
 * partial update. The browser normally sends a complete record, but keeping
 * omitted fields from the existing row prevents a title/source-ID edit from
 * silently clearing notes, tags, artwork, or provider metadata.
 */
function editableSubject(row: typeof userSubjects.$inferSelect): Record<string, unknown> {
  const metadata = parseMetadata(row.metadata);
  const tags = mergeTags(row.tags, row.characterTags);
  return {
    mediaType: row.type,
    subjectId: row.subjectId ?? undefined,
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
    characterTags: [],
    metadata,
  };
}

async function presentBrowserSubject(row: typeof userSubjects.$inferSelect & { snapshot: string }, storageLinks?: unknown[]) {
  const { snapshot, ...subject } = row;
  return { ...presentSubject(subject, snapshotGalleryImages(snapshot), storageLinks), revision: await mediaRevision(snapshot) };
}

export async function GET(request: Request) {
  const key = getCurrentUser();
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (id !== null && (!Number.isSafeInteger(Number(id)) || Number(id) <= 0)) return Response.json({ error: "无效的媒体记录 id" }, { status: 400 });
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const collection = url.searchParams.get("collection");
  const tag = url.searchParams.get("tag")?.trim();
  const query = url.searchParams.get("q")?.trim();
  try {
    const conditions = [eq(userSubjects.userKey, key)];
    if (id !== null) conditions.push(eq(userSubjects.id, Number(id)));
    if (type) conditions.push(eq(userSubjects.type, normalizeType(type)));
    if (status && STATUSES.includes(status as (typeof STATUSES)[number])) conditions.push(eq(userSubjects.status, status));
    if (collection) conditions.push(eq(userSubjects.collection, collection));
    if (tag) conditions.push(or(like(userSubjects.tags, `%${tag.slice(0, 80)}%`), like(userSubjects.characterTags, `%${tag.slice(0, 80)}%`))!);
    if (query) {
      conditions.push(or(like(userSubjects.title, `%${query.slice(0, 80)}%`), like(userSubjects.jp, `%${query.slice(0, 80)}%`), like(userSubjects.tags, `%${query.slice(0, 80)}%`), like(userSubjects.characterTags, `%${query.slice(0, 80)}%`), like(userSubjects.author, `%${query.slice(0, 80)}%`), like(userSubjects.pixivPid, `%${query.slice(0, 80)}%`), like(userSubjects.musicAlbum, `%${query.slice(0, 80)}%`), like(userSubjects.musicArtist, `%${query.slice(0, 80)}%`), like(userSubjects.lyricist, `%${query.slice(0, 80)}%`), like(userSubjects.composer, `%${query.slice(0, 80)}%`))!);
    }
    const db = getDb();
    const rows = await db.select(mediaSnapshotSelection).from(userSubjects).where(and(...conditions)).orderBy(desc(userSubjects.updatedAt));
    const storageMap = await mediaStorageLinksByMediaIds(db, key, rows.map((row) => row.id));
    const subjects = await Promise.all(rows.map((row) => presentBrowserSubject(row, storageMap.get(row.id))));
    return Response.json({ subjects, stats: { count: subjects.length, active: subjects.filter((item) => item.status === "watching").length } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取媒体记录失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const key = getCurrentUser();
  let createOperationId: number | null = null;
  try {
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "请求体必须是有效 JSON" }, { status: 400 });
    }
    const next = sanitizeSubject(body);
    const requestedId = Number(body.id);
    const db = getDb();
    if (Number.isInteger(requestedId) && requestedId > 0) {
      const [existing] = await db.select(mediaSnapshotSelection).from(userSubjects).where(and(eq(userSubjects.id, requestedId), eq(userSubjects.userKey, key))).limit(1);
      if (!existing) return Response.json({ error: "媒体记录不存在或无权修改" }, { status: 404 });
      const expectedRevision = body.expectedRevision;
      // Old browser tabs must never replace an image set without proving which
      // set they edited. Agent and MCP writes use their own routes/contracts.
      if (expectedRevision !== undefined && expectedRevision !== await mediaRevision(existing.snapshot)
        || body.images !== undefined && typeof expectedRevision !== "string") throw new MediaConflictError();
      const existingImages = snapshotGalleryImages(existing.snapshot);
      const merged = { ...editableSubject(existing), ...body };
      if (body.metadata !== undefined) {
        const previousMetadata = parseMetadata(existing.metadata);
        const patchMetadata = parseMetadataPatch(body.metadata);
        merged.metadata = { ...previousMetadata, ...patchMetadata };
      }
      // Preserve the legacy aliases used by video forms when only one alias
      // is supplied in a partial payload.
      if (body.note === undefined && body.description !== undefined) merged.note = body.description;
      if (body.image === undefined && body.cover !== undefined) merged.image = body.cover;
      const updated = sanitizeSubject(merged);
      const writes: MediaWriteQuery[] = [db.update(userSubjects).set(updated).where(and(eq(userSubjects.id, requestedId), eq(userSubjects.userKey, key)))];
      const unusedUrls: string[] = [];
      if (updated.type === "visual") {
        let images = body.images;
        if (images === undefined && updated.thumbnail && updated.thumbnail !== existing.thumbnail) {
          const found = existingImages.some((image) => image.thumbnail === updated.thumbnail);
          if (!found && existingImages.length >= MAX_GALLERY_IMAGES) return Response.json({ error: `每个画廊条目最多保存 ${MAX_GALLERY_IMAGES} 张图片` }, { status: 400 });
          images = [...existingImages.map((image) => ({ ...image, isCover: image.thumbnail === updated.thumbnail })), ...(!found ? [{ thumbnail: updated.thumbnail, isCover: true }] : [])];
        }
        if (images !== undefined) {
          const plan = planGalleryImageSync(db, key, requestedId, images, existingImages);
          writes.push(...plan.writes);
          unusedUrls.push(...plan.removedUrls);
        }
      } else if (existing.type === "visual") {
        writes.push(db.delete(userSubjectImages).where(and(eq(userSubjectImages.userKey, key), eq(userSubjectImages.subjectId, requestedId))));
        unusedUrls.push(...existingImages.map((image) => image.thumbnail));
        if (existing.thumbnail) unusedUrls.push(existing.thumbnail);
      } else if (existing.thumbnail && existing.thumbnail !== updated.thumbnail) {
        unusedUrls.push(existing.thumbnail);
      }
      await writeMediaSnapshot(db, key, requestedId, existing.snapshot, writes);
      await cleanupDeletedGalleryAssets(db, key, unusedUrls);
      const [saved] = await db.select(mediaSnapshotSelection).from(userSubjects).where(and(eq(userSubjects.id, requestedId), eq(userSubjects.userKey, key))).limit(1);
      if (!saved) throw new MediaConflictError();
      const storageMap = await mediaStorageLinksByMediaIds(db, key, [requestedId]);
      return Response.json({ ok: true, subject: await presentBrowserSubject(saved, storageMap.get(requestedId)) }, { headers: { "cache-control": "no-store" } });
    }
    // A stable browser key makes a lost response safe to retry. Older clients
    // without a key remain compatible; a provided invalid key must fail closed.
    if (Object.prototype.hasOwnProperty.call(body, "idempotencyKey") || request.headers.has("idempotency-key") || request.headers.has("x-idempotency-key")) {
      const reservation = await reserveAgentOperation({ agent: "browser", source: "browser", userKey: key }, {
        request, body, resource: "media", action: "create",
      });
      if (reservation.kind !== "reserved") {
        if (reservation.kind === "replayed" && reservation.response.status === 201) {
          const receipt = await reservation.response.clone().json() as { subject?: { id?: number } };
          const createdId = receipt.subject?.id;
          const [stillPresent] = createdId ? await db.select({ id: userSubjects.id }).from(userSubjects)
            .where(and(eq(userSubjects.id, createdId), eq(userSubjects.userKey, key))).limit(1) : [];
          if (!stillPresent) return Response.json({ error: "原请求创建的收藏已被删除，重试不会重新创建。", code: "operation_resource_missing", retryable: false }, {
            status: 409, headers: { "cache-control": "no-store", "x-idempotent-replay": "true" },
          });
        }
        return reservation.response;
      }
      createOperationId = reservation.id;
    }
    const [created] = await db.insert(userSubjects).values({ ...next, userKey: key }).returning();
    if (!created) return Response.json({ error: "写入失败" }, { status: 500 });
    if (created.type === "visual") {
      if (body.images !== undefined) await syncGalleryImages(db, key, created.id, body.images);
      else if (created.thumbnail) await appendGalleryImage(db, key, created.id, { thumbnail: created.thumbnail, isCover: true });
    }
    const [saved] = await db.select(mediaSnapshotSelection).from(userSubjects).where(and(eq(userSubjects.id, created.id), eq(userSubjects.userKey, key))).limit(1);
    if (!saved) throw new MediaConflictError();
    const storageMap = await mediaStorageLinksByMediaIds(db, key, [created.id]);
    const payload = { ok: true, subject: await presentBrowserSubject(saved, storageMap.get(created.id)) };
    if (createOperationId !== null) await finishAgentOperation(createOperationId, 201, payload);
    return Response.json(payload, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (createOperationId !== null) {
      // Once a persistent write was attempted, failure is not proof that it
      // rolled back. Leave the reservation pending; never release it for a
      // second create or overwrite a success receipt that may have committed.
      return Response.json({ error: "收藏创建结果暂时无法确认，请保留原请求重试并核对收藏，不要重复新建。", code: "operation_outcome_unknown", retryable: false }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    if (error instanceof MediaConflictError) return Response.json({ error: error.message, code: "media_conflict" }, { status: 409, headers: { "cache-control": "no-store" } });
    return Response.json({ error: error instanceof Error ? error.message : "保存媒体记录失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const key = getCurrentUser();
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "缺少媒体记录 id" }, { status: 400 });
  try {
    const db = getDb();
    const [existing] = await db.select().from(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, key))).limit(1);
    if (!existing) return Response.json({ error: "媒体记录不存在或无权删除" }, { status: 404 });
    const imageUrls = existing.type === "visual" ? await deleteGalleryImagesForSubjects(db, key, [id]) : [];
    const deleted = await db.delete(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, key))).returning({ id: userSubjects.id });
    if (!deleted.length) return Response.json({ error: "媒体记录不存在或无权删除" }, { status: 404 });
    if (existing.thumbnail) imageUrls.push(existing.thumbnail);
    if (imageUrls.length) await cleanupDeletedGalleryAssets(db, key, imageUrls);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "删除媒体记录失败" }, { status: 500 });
  }
}
