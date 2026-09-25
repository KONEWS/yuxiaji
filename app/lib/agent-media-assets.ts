import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb } from "../../db";
import { userSubjects } from "../../db/schema";
import { mergeTags, parseMetadata, presentSubject, sanitizeSubject } from "../api/media/route";
import { authenticateAgent, isAgentIdentity, requireAgentPermission, type AgentIdentity, type AgentPermission } from "./agent-auth";
import { agentJson, finishAgentOperation, reserveAgentOperation } from "./agent-operations";
import { appendGalleryImage, cleanupDeletedGalleryAssets, deleteGalleryImagesForSubjects, galleryImagesBySubjectIds, syncGalleryImages, type GalleryImageRow } from "./gallery-images";

export type AgentAssetType = "visual" | "video";
type AssetAction = "create" | "update" | "delete";
type AssetPermissionMap = Record<"read" | AssetAction, AgentPermission>;

const ASSET_CONFIG = {
  visual: {
    resource: "gallery",
    plural: "galleries",
    singular: "gallery",
    subtypeColumn: "visualSubtype",
    permissions: {
      read: "gallery:read",
      create: "gallery:create",
      update: "gallery:update",
      delete: "gallery:delete",
    },
  },
  video: {
    resource: "video",
    plural: "videos",
    singular: "video",
    subtypeColumn: "videoSubtype",
    permissions: {
      read: "video:read",
      create: "video:create",
      update: "video:update",
      delete: "video:delete",
    },
  },
} as const satisfies Record<AgentAssetType, {
  resource: string;
  plural: string;
  singular: string;
  subtypeColumn: "visualSubtype" | "videoSubtype";
  permissions: AssetPermissionMap;
}>;

const STATUSES = ["watching", "wish", "finished", "library", "dropped"] as const;

function configFor(type: AgentAssetType) {
  return ASSET_CONFIG[type];
}

function parseId(request: Request, body?: Record<string, unknown>) {
  const queryId = Number(new URL(request.url).searchParams.get("id"));
  if (Number.isInteger(queryId) && queryId > 0) return queryId;
  const bodyId = Number(body?.id);
  return Number.isInteger(bodyId) && bodyId > 0 ? bodyId : null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const value = await request.clone().json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return agentJson({ error: "请求体必须是 JSON 对象" }, 400);
    return value as Record<string, unknown>;
  } catch {
    return agentJson({ error: "请求体必须是 JSON" }, 400);
  }
}

function metadataPatch(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

type GalleryDuplicate = {
  existingId: number;
  reason: "pixivPid already exists" | "sourceUrl already exists" | "twitterSource already exists" | "imageHash already exists";
};

function trimmedSource(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function metadataImageHash(value: unknown) {
  const metadata = metadataPatch(value);
  return trimmedSource(metadata.imageHash, 128);
}

async function findGalleryDuplicate(
  db: ReturnType<typeof getDb>,
  userKey: string,
  body: Record<string, unknown>,
) : Promise<GalleryDuplicate | null> {
  const pixivPid = trimmedSource(body.pixivPid, 80);
  if (pixivPid) {
    const [row] = await db.select({ id: userSubjects.id }).from(userSubjects).where(and(
      eq(userSubjects.userKey, userKey),
      eq(userSubjects.type, "visual"),
      eq(userSubjects.pixivPid, pixivPid),
    )).limit(1);
    if (row) return { existingId: row.id, reason: "pixivPid already exists" };
  }

  const sourceUrl = trimmedSource(body.sourceUrl, 1000);
  if (sourceUrl) {
    const [row] = await db.select({ id: userSubjects.id }).from(userSubjects).where(and(
      eq(userSubjects.userKey, userKey),
      eq(userSubjects.type, "visual"),
      or(eq(userSubjects.sourceUrl, sourceUrl), eq(userSubjects.twitterSource, sourceUrl))!,
    )).limit(1);
    if (row) return { existingId: row.id, reason: "sourceUrl already exists" };
  }

  const twitterSource = trimmedSource(body.twitterSource, 500);
  if (twitterSource) {
    const [row] = await db.select({ id: userSubjects.id }).from(userSubjects).where(and(
      eq(userSubjects.userKey, userKey),
      eq(userSubjects.type, "visual"),
      or(eq(userSubjects.sourceUrl, twitterSource), eq(userSubjects.twitterSource, twitterSource))!,
    )).limit(1);
    if (row) return { existingId: row.id, reason: "twitterSource already exists" };
  }

  const imageHash = metadataImageHash(body.metadata);
  if (!imageHash) return null;

  // D1 does not need a schema change for this metadata key. Read visual
  // candidates and compare the parsed JSON exactly to avoid substring matches.
  const candidates = await db.select({ id: userSubjects.id, metadata: userSubjects.metadata }).from(userSubjects).where(and(
    eq(userSubjects.userKey, userKey),
    eq(userSubjects.type, "visual"),
  ));
  const match = candidates.find((row) => metadataImageHash(row.metadata) === imageHash);
  return match ? { existingId: match.id, reason: "imageHash already exists" } : null;
}

/**
 * OpenClaw callers use both the media API names and video-oriented aliases.
 * Normalize those aliases before the shared media sanitizer runs so a video
 * request can never silently become an anime record.
 */
function normalizeVideoFields(input: Record<string, unknown>, body: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { ...input, type: "video", mediaType: "video" };
  const aliases: Array<[string, string]> = [
    ["image", "cover"],
    ["image", "coverImage"],
    ["thumbnail", "thumbnailUrl"],
    ["sourceUrl", "url"],
    ["videoSubtype", "subtype"],
    ["note", "description"],
  ];
  for (const [canonical, alias] of aliases) {
    if (body[canonical] === undefined && body[alias] !== undefined) normalized[canonical] = body[alias];
  }
  return normalized;
}

function rowInput(row: typeof userSubjects.$inferSelect) {
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

function normalizedInput(type: AgentAssetType, body: Record<string, unknown>, existing?: typeof userSubjects.$inferSelect) {
  const base = existing ? rowInput(existing) : {};
  const metadata = existing
    ? { ...parseMetadata(existing.metadata), ...metadataPatch(body.metadata) }
    : body.metadata;
  const input = { ...base, ...body };
  const normalized = type === "video" ? normalizeVideoFields(input, body) : input;
  return sanitizeSubject({ ...normalized, metadata, type, mediaType: type });
}

function assetWithAgent(row: typeof userSubjects.$inferSelect, type: AgentAssetType, agent: AgentIdentity["agent"], images?: GalleryImageRow[]) {
  return { ...presentSubject(row, images), assetType: type, managedBy: "openclaw", agent };
}

async function writeAsset(request: Request, identity: AgentIdentity, type: AgentAssetType, action: "create" | "update", body: Record<string, unknown>, id: number | null) {
  const config = configFor(type);
  const denied = requireAgentPermission(identity, config.permissions[action]);
  if (denied) return denied;
  const reservation = await reserveAgentOperation(identity, { request, body, resource: config.resource, action, resourceId: id });
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const db = getDb();
    let existing: typeof userSubjects.$inferSelect | undefined;
    if (action === "update" && id) {
      [existing] = await db.select().from(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey), eq(userSubjects.type, type))).limit(1);
      if (!existing) {
        const payload = { error: `${type === "visual" ? "画廊" : "视频"}记录不存在或无权修改` };
        await finishAgentOperation(reservation.id, 404, payload);
        return agentJson(payload, 404);
      }
    }
    const next = normalizedInput(type, body, existing);
    if (type === "visual" && action === "create") {
      const duplicate = await findGalleryDuplicate(db, identity.userKey, body);
      if (duplicate) {
        const payload = {
          duplicate: true,
          existingId: duplicate.existingId,
          reason: duplicate.reason,
        };
        await finishAgentOperation(reservation.id, 409, payload);
        return agentJson(payload, 409);
      }
    }
    let row: typeof userSubjects.$inferSelect;
    let status = 201;
    if (existing && id) {
      await db.update(userSubjects).set(next).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey), eq(userSubjects.type, type)));
      if (type === "visual") {
        if (body.images !== undefined) await syncGalleryImages(db, identity.userKey, id, body.images);
        else if (next.thumbnail && next.thumbnail !== existing.thumbnail) await appendGalleryImage(db, identity.userKey, id, { thumbnail: next.thumbnail, isCover: true });
      }
      [row] = await db.select().from(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey), eq(userSubjects.type, type))).limit(1);
      if (!row) throw new Error("保存后的画廊记录无法读取");
      status = 200;
    } else {
      const [created] = await db.insert(userSubjects).values({ ...next, userKey: identity.userKey }).returning();
      if (!created) throw new Error("写入媒体记录失败");
      if (type === "visual") {
        if (body.images !== undefined) await syncGalleryImages(db, identity.userKey, created.id, body.images);
        else if (created.thumbnail) await appendGalleryImage(db, identity.userKey, created.id, { thumbnail: created.thumbnail, isCover: true });
      }
      [row] = await db.select().from(userSubjects).where(and(eq(userSubjects.id, created.id), eq(userSubjects.userKey, identity.userKey), eq(userSubjects.type, type))).limit(1);
      if (!row) throw new Error("写入后的记录无法读取");
    }
    const imageMap = await galleryImagesBySubjectIds(db, identity.userKey, type === "visual" ? [row.id] : []);
    const payload = {
      ok: true,
      source: "openclaw",
      agent: identity.agent,
      idempotencyKey: reservation.idempotencyKey,
      [config.singular]: assetWithAgent(row, type, identity.agent, imageMap.get(row.id)),
    };
    await finishAgentOperation(reservation.id, status, payload);
    return agentJson(payload, status);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : "保存记录失败" };
    await finishAgentOperation(reservation.id, 500, payload);
    return agentJson(payload, 500);
  }
}

async function listAssets(request: Request, identity: AgentIdentity, type: AgentAssetType) {
  const config = configFor(type);
  const denied = requireAgentPermission(identity, config.permissions.read);
  if (denied) return denied;
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  const subtype = url.searchParams.get("subtype")?.trim();
  const status = url.searchParams.get("status");
  const collection = url.searchParams.get("collection");
  const tag = url.searchParams.get("tag")?.trim();
  const query = url.searchParams.get("q")?.trim();
  try {
    const conditions = [eq(userSubjects.userKey, identity.userKey), eq(userSubjects.type, type)];
    if (Number.isInteger(id) && id > 0) conditions.push(eq(userSubjects.id, id));
    if (subtype) conditions.push(eq(type === "visual" ? userSubjects.visualSubtype : userSubjects.videoSubtype, subtype));
    if (status && STATUSES.includes(status as (typeof STATUSES)[number])) conditions.push(eq(userSubjects.status, status));
    if (collection) conditions.push(eq(userSubjects.collection, collection));
    if (tag) conditions.push(or(like(userSubjects.tags, `%${tag.slice(0, 80)}%`), like(userSubjects.characterTags, `%${tag.slice(0, 80)}%`))!);
    if (query) {
      const term = `%${query.slice(0, 80)}%`;
      conditions.push(or(
        like(userSubjects.title, term),
        like(userSubjects.jp, term),
        like(userSubjects.note, term),
        like(userSubjects.tags, term),
        like(userSubjects.characterTags, term),
        like(userSubjects.author, term),
        like(userSubjects.sourceUrl, term),
        like(userSubjects.metadata, term),
      )!);
    }
    const db = getDb();
    const rows = await db.select().from(userSubjects).where(and(...conditions)).orderBy(desc(userSubjects.updatedAt));
    const imageMap = await galleryImagesBySubjectIds(db, identity.userKey, type === "visual" ? rows.map((row) => row.id) : []);
    const assets = rows.map((row) => assetWithAgent(row, type, identity.agent, imageMap.get(row.id)));
    return agentJson({
      [config.plural]: assets,
      [config.singular]: Number.isInteger(id) && id > 0 ? assets[0] || null : undefined,
      stats: { count: assets.length, active: assets.filter((asset) => asset.status === "watching").length },
      source: "openclaw",
      agent: identity.agent,
    });
  } catch (error) {
    return agentJson({ error: error instanceof Error ? error.message : "读取记录失败" }, 500);
  }
}

async function deleteAsset(request: Request, identity: AgentIdentity, type: AgentAssetType) {
  const config = configFor(type);
  const denied = requireAgentPermission(identity, config.permissions.delete);
  if (denied) return denied;
  let body: Record<string, unknown> | undefined;
  if (type === "video" && request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    try {
      const parsed = await request.clone().json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // The idempotency key may still be supplied in the request header.
    }
  }
  const id = type === "video" ? parseId(request, body) : parseId(request);
  if (!id) return agentJson({ error: `缺少${type === "visual" ? "画廊" : "视频"}记录 id` }, 400);
  const reservation = await reserveAgentOperation(identity, { request, body, resource: config.resource, action: "delete", resourceId: id });
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const db = getDb();
    const [existing] = await db.select().from(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey), eq(userSubjects.type, type))).limit(1);
    if (!existing) {
      const payload = { error: `${type === "visual" ? "画廊" : "视频"}记录不存在或无权删除` };
      await finishAgentOperation(reservation.id, 404, payload);
      return agentJson(payload, 404);
    }
    const imageUrls = type === "visual" ? await deleteGalleryImagesForSubjects(db, identity.userKey, [id]) : [];
    const deleted = await db.delete(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey), eq(userSubjects.type, type))).returning({ id: userSubjects.id });
    if (!deleted.length) {
      const payload = { error: `${type === "visual" ? "画廊" : "视频"}记录不存在或无权删除` };
      await finishAgentOperation(reservation.id, 404, payload);
      return agentJson(payload, 404);
    }
    if (existing.thumbnail) imageUrls.push(existing.thumbnail);
    if (imageUrls.length) await cleanupDeletedGalleryAssets(db, identity.userKey, imageUrls);
    const payload = { ok: true, source: "openclaw", agent: identity.agent, idempotencyKey: reservation.idempotencyKey, deleted: { id, type } };
    await finishAgentOperation(reservation.id, 200, payload);
    return agentJson(payload);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : "删除记录失败" };
    await finishAgentOperation(reservation.id, 500, payload);
    return agentJson(payload, 500);
  }
}

export async function handleAgentAsset(request: Request, type: AgentAssetType) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  if (request.method === "GET") return listAssets(request, identity, type);
  if (request.method === "DELETE") return deleteAsset(request, identity, type);
  if (request.method !== "POST" && request.method !== "PATCH") return agentJson({ error: "不支持的请求方法" }, 405, { allow: "GET, POST, PATCH, DELETE" });
  const parsed = await readJson(request);
  if (parsed instanceof Response) return parsed;
  const id = parseId(request, parsed);
  if (request.method === "PATCH" && !id) return agentJson({ error: `修改${type === "visual" ? "画廊" : "视频"}需要记录 id` }, 400);
  return writeAsset(request, identity, type, request.method === "PATCH" ? "update" : "create", parsed, request.method === "PATCH" ? id : null);
}
