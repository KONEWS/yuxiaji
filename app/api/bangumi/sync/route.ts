import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userSubjects } from "../../../../db/schema";
import { bangumiRequestOptions, getAllBangumiUserCollections, getBangumiSubject, subjectImage, subjectScore, subjectTags } from "../../../lib/bangumi-api";
import { getCurrentUser } from "../../../lib/current-user";

const MEDIA_TYPES = ["anime", "game", "light_novel", "manga", "music"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

function normalizeTypes(value: unknown): MediaType[] {
  const values = Array.isArray(value) ? value : MEDIA_TYPES;
  return Array.from(new Set(values.map((item) => item === "novel" || item === "book" ? "light_novel" : String(item)).filter((item): item is MediaType => MEDIA_TYPES.includes(item as MediaType))));
}

function normalizeSubjectIds(value: unknown) {
  if (!Array.isArray(value)) return null;
  const ids = value.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 100);
  return ids.length ? Array.from(new Set(ids)) : null;
}

function mediaTypeForBangumiId(value: unknown) {
  return value === 2 ? "anime" : value === 4 ? "game" : value === 3 ? "music" : value === 1 ? "light_novel" : null;
}

function statusForCollectionType(value: unknown) {
  return value === 1 ? "wish" : value === 2 ? "finished" : value === 3 ? "watching" : value === 4 ? "library" : value === 5 ? "dropped" : "watching";
}

export async function GET() {
  return Response.json({
    provider: "bangumi",
    oauth: false,
    supportsPublicApi: true,
    supportsUserToken: true,
    userTokenHeader: "x-bangumi-user-token",
    mediaTypes: MEDIA_TYPES,
  }, { headers: { "cache-control": "public, max-age=300" } });
}

export async function POST(request: Request) {
  const key = getCurrentUser();
  try {
    const body = await request.json() as { types?: unknown; syncTypes?: unknown; subjectIds?: unknown; userToken?: unknown; mode?: unknown; username?: unknown };
    const types = normalizeTypes(body.types ?? body.syncTypes);
    if (!types.length) return Response.json({ error: "没有可同步的媒体类型" }, { status: 400 });
    const subjectIds = normalizeSubjectIds(body.subjectIds);
    const conditions = [eq(userSubjects.userKey, key), inArray(userSubjects.type, types)];
    if (subjectIds) conditions.push(inArray(userSubjects.subjectId, subjectIds));
    const rows = await getDb().select().from(userSubjects).where(and(...conditions)).limit(100);
    const options = { ...bangumiRequestOptions(request), userToken: typeof body.userToken === "string" ? body.userToken : bangumiRequestOptions(request).userToken };
    if (body.mode === "import") {
      const username = typeof body.username === "string" ? body.username : "";
      const collections = await getAllBangumiUserCollections(username, options, 100);
      const selected = collections.filter((item) => {
        const type = mediaTypeForBangumiId(item.subject_type);
        return type && types.includes(type);
      }).slice(0, 100);
      const results = await Promise.allSettled(selected.map(async (item) => {
        const mediaType = mediaTypeForBangumiId(item.subject_type)!;
        const subject = await getBangumiSubject(item.subject_id, options);
        const data = {
          type: mediaType,
          subjectId: item.subject_id,
          title: subject.name_cn || subject.name,
          jp: subject.name,
          note: item.comment || "",
          progress: 0,
          total: mediaType === "music" ? 1 : mediaType === "game" ? 100 : subject.eps || 12,
          status: statusForCollectionType(item.type ?? item.collection_type),
          kind: "coral",
          score: Number.isInteger(item.rate) && item.rate! >= 1 && item.rate! <= 10 ? item.rate : null,
          next: null,
          image: subjectImage(subject) || null,
          globalScore: subjectScore(subject) || null,
          source: "bangumi",
          collection: "",
          tags: JSON.stringify([...subjectTags(subject), ...(item.tags || [])].slice(0, 30)),
          musicAlbum: "",
          musicArtist: "",
          lyricist: "",
          composer: "",
          animeSong: mediaType === "music" && subjectTags(subject).some((tag) => /动画|原声|主题曲|片尾|片头/.test(tag)),
          updatedAt: new Date(),
        };
        const [existing] = await getDb().select().from(userSubjects).where(and(eq(userSubjects.userKey, key), eq(userSubjects.subjectId, item.subject_id))).limit(1);
        if (existing) {
          await getDb().update(userSubjects).set(data).where(and(eq(userSubjects.id, existing.id), eq(userSubjects.userKey, key)));
          return { mediaId: existing.id, subjectId: item.subject_id, imported: true };
        }
        const [created] = await getDb().insert(userSubjects).values({ ...data, userKey: key }).returning({ id: userSubjects.id });
        return { mediaId: created?.id, subjectId: item.subject_id, imported: true };
      }));
      const imported = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
      return Response.json({ ok: true, provider: "bangumi", authMode: options.userToken ? "user_token" : "public", mode: "import", requested: selected.length, synced: imported.length, failed: selected.length - imported.length, updates: imported, errors: [] }, { headers: { "cache-control": "no-store" } });
    }
    const results = await Promise.allSettled(rows.filter((row) => row.subjectId).map(async (row) => {
      const subject = await getBangumiSubject(row.subjectId!, options);
      const next = {
        jp: row.jp || subject.name,
        total: subject.eps && subject.eps > 0 ? subject.eps : row.total,
        image: subjectImage(subject) || row.image,
        globalScore: subjectScore(subject) || row.globalScore,
        source: "bangumi",
        updatedAt: new Date(),
      };
      await getDb().update(userSubjects).set(next).where(and(eq(userSubjects.id, row.id), eq(userSubjects.userKey, key)));
      return { mediaId: row.id, subjectId: row.subjectId, ...next, updatedAt: next.updatedAt.getTime() };
    }));
    const updates: Array<Record<string, unknown>> = [];
    const errors: Array<{ mediaId: number; subjectId: number; error: string }> = [];
    results.forEach((result, index) => {
      const row = rows.filter((item) => item.subjectId)[index];
      if (result.status === "fulfilled") updates.push(result.value);
      else if (row?.subjectId) errors.push({ mediaId: row.id, subjectId: row.subjectId, error: result.reason instanceof Error ? result.reason.message : "同步失败" });
    });
    return Response.json({
      ok: true,
      provider: "bangumi",
      authMode: options.userToken ? "user_token" : "public",
      requested: rows.filter((row) => row.subjectId).length,
      synced: updates.length,
      failed: errors.length,
      updates,
      errors,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Bangumi 同步失败" }, { status: 502 });
  }
}
