import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userSubjects } from "../../../../db/schema";
import { authenticateAgent, isAgentIdentity, requireAgentPermission, type AgentIdentity } from "../../../lib/agent-auth";
import { agentJson, finishAgentOperation, reserveAgentOperation } from "../../../lib/agent-operations";
import { mergeTags, parseMetadata, presentSubject, sanitizeSubject } from "../../media/route";
import { appendGalleryImage, cleanupDeletedGalleryAssets, deleteGalleryImagesForSubjects, galleryImagesBySubjectIds, syncGalleryImages, type GalleryImageRow } from "../../../lib/gallery-images";
import { mediaStorageLinksByMediaIds } from "../../../lib/media-storage-link-store";

const MEDIA_TYPES = ["anime", "movie", "tv", "game", "light_novel", "manga", "music", "visual", "video"] as const;
const STATUSES = ["watching", "wish", "finished", "library", "dropped"] as const;

function mediaScope(id: number, userKey: string) {
  return and(eq(userSubjects.id, id), eq(userSubjects.userKey, userKey));
}

function normalizeType(value: unknown) {
  if (value === "novel" || value === "book") return "light_novel";
  return MEDIA_TYPES.includes(value as (typeof MEDIA_TYPES)[number]) ? value as string : "anime";
}

function agentSubject(row: typeof userSubjects.$inferSelect, images?: GalleryImageRow[], storageLinks?: unknown[]) {
  const presented = presentSubject(row, images, storageLinks);
  return {
    ...presented,
    managedBy: "openclaw",
  };
}

function errorDetails(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  return message.slice(0, 2000);
}

function errorJson(error: unknown, fallback: string, status = 500) {
  return agentJson({ error: fallback, details: errorDetails(error) }, status);
}

function subjectInput(row: typeof userSubjects.$inferSelect) {
  return {
    type: row.type,
    mediaType: row.type,
    subjectId: row.subjectId ?? undefined,
    title: row.title,
    jp: row.jp,
    note: row.note,
    progress: row.progress,
    total: row.total,
    status: row.status,
    kind: row.kind,
    score: row.score ?? undefined,
    next: row.next ?? undefined,
    image: row.image || "",
    cover: row.image || "",
    globalScore: row.globalScore ?? undefined,
    source: row.source,
    collection: row.collection,
    tags: mergeTags(row.tags, row.characterTags),
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
    metadata: parseMetadata(row.metadata),
  };
}

function mergeMediaPatch(existing: typeof userSubjects.$inferSelect, body: Record<string, unknown>) {
  const base = subjectInput(existing);
  const merged = { ...base, ...body } as Record<string, unknown>;

  // Preserve partial metadata updates instead of normalizing an omitted key
  // back to the metadata defaults.
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    merged.metadata = { ...base.metadata, ...(body.metadata as Record<string, unknown>) };
  }
  if (body.note === undefined && body.description !== undefined) merged.note = body.description;
  if (body.image === undefined && body.cover !== undefined) merged.image = body.cover;
  if (body.thumbnail === undefined && body.thumbnailUrl !== undefined) merged.thumbnail = body.thumbnailUrl;
  if (body.sourceUrl === undefined && body.url !== undefined) merged.sourceUrl = body.url;
  return merged;
}

async function finishOperation(id: number, status: number, payload: unknown) {
  try {
    await finishAgentOperation(id, status, payload);
    return null;
  } catch (error) {
    return error;
  }
}

async function readMediaBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const value = await request.clone().json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return agentJson({ error: "请求体必须是 JSON 对象", details: "POST/PATCH 需要一个 JSON object" }, 400);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    return errorJson(error, "请求体必须是 JSON", 400);
  }
}

async function writeMedia(request: Request, identity: AgentIdentity, action: "create" | "update", body: Record<string, unknown>) {
  const requestedId = Number(body.id);
  const id = Number.isInteger(requestedId) && requestedId > 0 ? requestedId : null;
  const permission = action === "create" ? "media:create" : "media:update";
  const denied = requireAgentPermission(identity, permission);
  if (denied) return denied;
  let reservation: Awaited<ReturnType<typeof reserveAgentOperation>>;
  try {
    reservation = await reserveAgentOperation(identity, { request, body, resource: "media", action, resourceId: id });
  } catch (error) {
    return errorJson(error, "媒体操作记录失败");
  }
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const db = getDb();
    let row: typeof userSubjects.$inferSelect;
    let status = 201;
    if (id) {
      const [existing] = await db.select().from(userSubjects).where(mediaScope(id, identity.userKey)).limit(1);
      if (!existing) {
        const payload = { error: "媒体记录不存在或无权修改", details: `id=${id}` };
        const finishError = await finishOperation(reservation.id, 404, payload);
        if (finishError) return errorJson(finishError, "媒体操作记录失败");
        return agentJson(payload, 404);
      }
      const next = sanitizeSubject(mergeMediaPatch(existing, body));
      const [updated] = await db.update(userSubjects).set(next).where(mediaScope(id, identity.userKey)).returning();
      if (!updated) throw new Error(`媒体记录更新后无法读取: id=${id}, userKey=${identity.userKey}`);
      if (updated.type === "visual") {
        if (body.images !== undefined) await syncGalleryImages(db, identity.userKey, id, body.images);
        else if (updated.thumbnail && updated.thumbnail !== existing.thumbnail) await appendGalleryImage(db, identity.userKey, id, { thumbnail: updated.thumbnail, isCover: true });
      } else if (existing.type === "visual") {
        const oldUrls = await deleteGalleryImagesForSubjects(db, identity.userKey, [id]);
        if (existing.thumbnail) oldUrls.push(existing.thumbnail);
        await cleanupDeletedGalleryAssets(db, identity.userKey, oldUrls);
      }
      [row] = await db.select().from(userSubjects).where(mediaScope(id, identity.userKey)).limit(1);
      if (!row) throw new Error("保存后的媒体记录无法读取");
      status = 200;
    } else {
      const next = sanitizeSubject(body);
      const [created] = await db.insert(userSubjects).values({ ...next, userKey: identity.userKey }).returning();
      if (!created) throw new Error("写入媒体记录失败");
      if (created.type === "visual") {
        if (body.images !== undefined) await syncGalleryImages(db, identity.userKey, created.id, body.images);
        else if (created.thumbnail) await appendGalleryImage(db, identity.userKey, created.id, { thumbnail: created.thumbnail, isCover: true });
      }
      [row] = await db.select().from(userSubjects).where(mediaScope(created.id, identity.userKey)).limit(1);
      if (!row) throw new Error("写入后的媒体记录无法读取");
    }
    const imageMap = await galleryImagesBySubjectIds(db, identity.userKey, row.type === "visual" ? [row.id] : []);
    const storageMap = await mediaStorageLinksByMediaIds(db, identity.userKey, [row.id]);
    const payload = { ok: true, source: "openclaw", agent: identity.agent, idempotencyKey: reservation.idempotencyKey, subject: agentSubject(row, imageMap.get(row.id), storageMap.get(row.id)) };
    const finishError = await finishOperation(reservation.id, status, payload);
    if (finishError) return errorJson(finishError, "媒体已写入，但操作记录失败");
    return agentJson(payload, status);
  } catch (error) {
    const payload = { error: "保存媒体记录失败", details: errorDetails(error) };
    const finishError = await finishOperation(reservation.id, 500, payload);
    if (finishError) payload.details = `${payload.details}; 操作记录更新失败: ${errorDetails(finishError)}`.slice(0, 2000);
    return agentJson(payload, 500);
  }
}

export async function GET(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "media:read");
  if (denied) return denied;
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const collection = url.searchParams.get("collection");
  const tag = url.searchParams.get("tag")?.trim();
  const query = url.searchParams.get("q")?.trim();
  try {
    // An id lookup must use exactly the same ownership scope as PATCH.
    // Do not let list filters (type/status/tag/query) hide an existing row.
    if (Number.isInteger(id) && id > 0) {
      const [row] = await getDb().select().from(userSubjects).where(mediaScope(id, identity.userKey)).limit(1);
      const imageMap = row ? await galleryImagesBySubjectIds(getDb(), identity.userKey, row.type === "visual" ? [row.id] : []) : new Map();
      const storageMap = row ? await mediaStorageLinksByMediaIds(getDb(), identity.userKey, [row.id]) : new Map();
      const subject = row ? agentSubject(row, imageMap.get(row.id), storageMap.get(row.id)) : null;
      return agentJson({ subjects: subject ? [subject] : [], subject, source: "openclaw", agent: identity.agent });
    }
    const conditions = [eq(userSubjects.userKey, identity.userKey)];
    if (type) conditions.push(eq(userSubjects.type, normalizeType(type)));
    if (status && STATUSES.includes(status as (typeof STATUSES)[number])) conditions.push(eq(userSubjects.status, status));
    if (collection) conditions.push(eq(userSubjects.collection, collection));
    if (tag) conditions.push(or(like(userSubjects.tags, `%${tag.slice(0, 80)}%`), like(userSubjects.characterTags, `%${tag.slice(0, 80)}%`))!);
    if (query) {
      const term = `%${query.slice(0, 80)}%`;
      conditions.push(or(like(userSubjects.title, term), like(userSubjects.jp, term), like(userSubjects.tags, term), like(userSubjects.characterTags, term), like(userSubjects.author, term), like(userSubjects.musicAlbum, term), like(userSubjects.musicArtist, term))!);
    }
    const db = getDb();
    const rows = await db.select().from(userSubjects).where(and(...conditions)).orderBy(desc(userSubjects.updatedAt));
    const imageMap = await galleryImagesBySubjectIds(db, identity.userKey, rows.filter((row) => row.type === "visual").map((row) => row.id));
    const storageMap = await mediaStorageLinksByMediaIds(db, identity.userKey, rows.map((row) => row.id));
    const subjects = rows.map((row) => agentSubject(row, imageMap.get(row.id), storageMap.get(row.id)));
    return agentJson({ subjects, stats: { count: subjects.length, active: subjects.filter((item) => item.status === "watching").length }, source: "openclaw", agent: identity.agent });
  } catch (error) {
    return agentJson({ error: "读取媒体记录失败", details: errorDetails(error) }, 500);
  }
}

export async function POST(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const parsed = await readMediaBody(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed;
  return writeMedia(request, identity, Number(body.id) > 0 ? "update" : "create", body);
}

export async function PATCH(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const parsed = await readMediaBody(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed;
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(Number(body.id)) && Number.isInteger(id) && id > 0) body.id = id;
  if (!Number.isInteger(Number(body.id)) || Number(body.id) <= 0) {
    return agentJson({ error: "PATCH 修改媒体需要 id", details: "请在 JSON body 中传入正整数 id，或使用 /api/agent/media?id=<id>" }, 400);
  }
  return writeMedia(request, identity, "update", body);
}

export async function DELETE(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "media:delete");
  if (denied) return denied;
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return agentJson({ error: "缺少媒体记录 id" }, 400);
  let reservation: Awaited<ReturnType<typeof reserveAgentOperation>>;
  try {
    reservation = await reserveAgentOperation(identity, { request, resource: "media", action: "delete", resourceId: id });
  } catch (error) {
    return errorJson(error, "媒体操作记录失败");
  }
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const db = getDb();
    const [existing] = await db.select().from(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey))).limit(1);
    if (!existing) {
      const payload = { error: "媒体记录不存在或无权删除", details: `id=${id}` };
      const finishError = await finishOperation(reservation.id, 404, payload);
      if (finishError) return errorJson(finishError, "媒体操作记录失败");
      return agentJson(payload, 404);
    }
    const imageUrls = existing.type === "visual" ? await deleteGalleryImagesForSubjects(db, identity.userKey, [id]) : [];
    const deleted = await db.delete(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey))).returning({ id: userSubjects.id });
    if (!deleted.length) {
      const payload = { error: "媒体记录不存在或无权删除", details: `id=${id}` };
      const finishError = await finishOperation(reservation.id, 404, payload);
      if (finishError) return errorJson(finishError, "媒体操作记录失败");
      return agentJson(payload, 404);
    }
    if (existing.thumbnail) imageUrls.push(existing.thumbnail);
    if (imageUrls.length) await cleanupDeletedGalleryAssets(db, identity.userKey, imageUrls);
    const payload = { ok: true, source: "openclaw", agent: identity.agent, idempotencyKey: reservation.idempotencyKey, deleted: { id } };
    const finishError = await finishOperation(reservation.id, 200, payload);
    if (finishError) return errorJson(finishError, "媒体已删除，但操作记录失败");
    return agentJson(payload);
  } catch (error) {
    const payload = { error: "删除媒体记录失败", details: errorDetails(error) };
    const finishError = await finishOperation(reservation.id, 500, payload);
    if (finishError) payload.details = `${payload.details}; 操作记录更新失败: ${errorDetails(finishError)}`.slice(0, 2000);
    return agentJson(payload, 500);
  }
}
