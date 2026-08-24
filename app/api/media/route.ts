import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { userSubjects } from "../../../db/schema";
import { normalizeMediaSource } from "../../lib/media-source";
import { getCurrentUser } from "../../lib/current-user";
import { normalizeMediaMetadata, normalizeVideoSubtype, normalizeVisualSubtype } from "../../lib/constants";

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
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 30);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 30) : [];
  } catch {
    return value.split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 30);
  }
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

export function sanitizeSubject(body: Record<string, unknown>) {
  const type = normalizeType(body.mediaType ?? body.type);
  const total = Number(body.total);
  const progress = Number(body.progress);
  const score = Number(body.score);
  const globalScore = Number(body.globalScore);
  const safeTotal = ["music", "visual", "movie", "video"].includes(type) ? 1 : Number.isFinite(total) && total > 0 ? Math.floor(total) : type === "game" ? 100 : 12;
  const metadata = normalizeMediaMetadata({
    ...normalizeMediaMetadata(body.metadata),
    ...(typeof body.platform === "string" ? { platform: body.platform } : {}),
    ...(typeof body.creator === "string" ? { creator: body.creator } : {}),
    ...(typeof body.duration === "string" ? { duration: body.duration } : {}),
  });
  const videoMetadata = type === "video" && !metadata.videoSource
    ? normalizeMediaMetadata({ ...metadata, videoSource: parseText(body.source, 160) && !["manual", "local", "bangumi"].includes(parseText(body.source, 160)) ? parseText(body.source, 160) : undefined })
    : metadata;
  return {
    type,
    subjectId: !["music", "visual", "movie", "tv", "video"].includes(type) && Number.isInteger(Number(body.subjectId)) && Number(body.subjectId) > 0 ? Number(body.subjectId) : null,
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
    source: ["visual", "movie", "tv", "video"].includes(type) ? (type === "visual" && body.source === "local" ? "local" : "manual") : normalizeMediaSource(body.source, body.subjectId ? "bangumi" : "manual"),
    collection: parseText(body.collection, 120),
    tags: JSON.stringify(parseTags(body.tags)),
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
    characterTags: JSON.stringify(parseTags(body.characterTags)),
    metadata: JSON.stringify(videoMetadata),
    updatedAt: new Date(),
  };
}

export function presentSubject(row: typeof userSubjects.$inferSelect) {
  const metadata = parseMetadata(row.metadata);
  return {
    ...row,
    source: ["visual", "movie", "tv", "video"].includes(row.type) ? (row.type === "visual" && row.source === "local" ? "local" : "manual") : normalizeMediaSource(row.source, row.subjectId ? "bangumi" : "manual"),
    tags: parseTags(row.tags),
    characterTags: parseTags(row.characterTags),
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
  };
}

export async function GET(request: Request) {
  const key = getCurrentUser();
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const collection = url.searchParams.get("collection");
  const tag = url.searchParams.get("tag")?.trim();
  const query = url.searchParams.get("q")?.trim();
  try {
    const conditions = [eq(userSubjects.userKey, key)];
    if (type) conditions.push(eq(userSubjects.type, normalizeType(type)));
    if (status && STATUSES.includes(status as (typeof STATUSES)[number])) conditions.push(eq(userSubjects.status, status));
    if (collection) conditions.push(eq(userSubjects.collection, collection));
    if (tag) conditions.push(like(userSubjects.tags, `%${tag.slice(0, 80)}%`));
    if (query) {
      conditions.push(or(like(userSubjects.title, `%${query.slice(0, 80)}%`), like(userSubjects.jp, `%${query.slice(0, 80)}%`), like(userSubjects.tags, `%${query.slice(0, 80)}%`), like(userSubjects.characterTags, `%${query.slice(0, 80)}%`), like(userSubjects.author, `%${query.slice(0, 80)}%`), like(userSubjects.pixivPid, `%${query.slice(0, 80)}%`), like(userSubjects.musicAlbum, `%${query.slice(0, 80)}%`), like(userSubjects.musicArtist, `%${query.slice(0, 80)}%`), like(userSubjects.lyricist, `%${query.slice(0, 80)}%`), like(userSubjects.composer, `%${query.slice(0, 80)}%`))!);
    }
    const rows = await getDb().select().from(userSubjects).where(and(...conditions)).orderBy(desc(userSubjects.updatedAt));
    const subjects = rows.map(presentSubject);
    return Response.json({ subjects, stats: { count: subjects.length, active: subjects.filter((item) => item.status === "watching").length } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取媒体记录失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const key = getCurrentUser();
  try {
    const body = await request.json() as Record<string, unknown>;
    const next = sanitizeSubject(body);
    const requestedId = Number(body.id);
    const db = getDb();
    if (Number.isInteger(requestedId) && requestedId > 0) {
      const [existing] = await db.select().from(userSubjects).where(and(eq(userSubjects.id, requestedId), eq(userSubjects.userKey, key))).limit(1);
      if (!existing) return Response.json({ error: "媒体记录不存在或无权修改" }, { status: 404 });
      await db.update(userSubjects).set(next).where(and(eq(userSubjects.id, requestedId), eq(userSubjects.userKey, key)));
      return Response.json({ ok: true, subject: presentSubject({ ...existing, ...next, id: requestedId }) }, { headers: { "cache-control": "no-store" } });
    }
    const [created] = await db.insert(userSubjects).values({ ...next, userKey: key }).returning();
    if (!created) return Response.json({ error: "写入失败" }, { status: 500 });
    return Response.json({ ok: true, subject: presentSubject(created) }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存媒体记录失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const key = getCurrentUser();
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "缺少媒体记录 id" }, { status: 400 });
  try {
    const deleted = await getDb().delete(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, key))).returning({ id: userSubjects.id });
    if (!deleted.length) return Response.json({ error: "媒体记录不存在或无权删除" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "删除媒体记录失败" }, { status: 500 });
  }
}
