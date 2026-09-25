import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userSubjects } from "../../../../db/schema";
import { bangumiRequestOptions, getAllBangumiUserCollections, getBangumiSubject, subjectImage, subjectScore, subjectTags } from "../../../lib/bangumi-api";
import { getCurrentUser } from "../../../lib/current-user";
import { normalizeMediaMetadata, normalizeSyncSettings } from "../../../lib/constants";

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

function mediaTypeForBangumiId(value: unknown, platform = "", tags: string[] = []) {
  if (value === 1) {
    const descriptor = `${platform} ${tags.join(" ")}`.toLowerCase();
    return /漫画|コミック|manga|manhwa|manhua|webtoon/.test(descriptor) ? "manga" : "light_novel";
  }
  return value === 2 ? "anime" : value === 4 ? "game" : value === 3 ? "music" : null;
}

function canContainSelectedType(subjectType: unknown, selectedTypes: Set<MediaType>) {
  if (subjectType === 1) return selectedTypes.has("light_novel") || selectedTypes.has("manga");
  const type = mediaTypeForBangumiId(subjectType);
  return Boolean(type && selectedTypes.has(type));
}

function statusForCollectionType(value: unknown) {
  return value === 1 ? "wish" : value === 2 ? "finished" : value === 3 ? "watching" : value === 4 ? "library" : value === 5 ? "dropped" : "watching";
}

function mergeBangumiSource(metadataText: string | undefined, subjectId: number) {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(metadataText || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    // Keep malformed legacy metadata from aborting an import.
  }
  const sources = metadata.sources && typeof metadata.sources === "object" && !Array.isArray(metadata.sources) ? metadata.sources as Record<string, unknown> : {};
  return normalizeMediaMetadata({ ...metadata, sources: { ...sources, bangumi: String(subjectId) } });
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
    const body = await request.json() as { types?: unknown; syncTypes?: unknown; subjectIds?: unknown; userToken?: unknown; mode?: unknown; username?: unknown; syncSettings?: unknown };
    const types = normalizeTypes(body.types ?? body.syncTypes);
    if (!types.length) return Response.json({ error: "没有可同步的媒体类型" }, { status: 400 });
    const syncFields = normalizeSyncSettings(body.syncSettings).bangumi;
    const subjectIds = normalizeSubjectIds(body.subjectIds);
    // subject_id is an integer compatibility field also used by older VNDB
    // records. Only explicit Bangumi rows may be sent to the Bangumi API.
    const conditions = [eq(userSubjects.userKey, key), inArray(userSubjects.type, types), eq(userSubjects.source, "bangumi")];
    if (subjectIds) conditions.push(inArray(userSubjects.subjectId, subjectIds));
    const rows = await getDb().select().from(userSubjects).where(and(...conditions)).limit(100);
    const options = { ...bangumiRequestOptions(request), userToken: typeof body.userToken === "string" ? body.userToken : bangumiRequestOptions(request).userToken };
    if (body.mode === "import") {
      const username = typeof body.username === "string" ? body.username : "";
      const collections = await getAllBangumiUserCollections(username, options, 100);
      const selectedTypes = new Set(types);
      const selected = collections.filter((item) => canContainSelectedType(item.subject_type, selectedTypes)).slice(0, 100);
      const results = await Promise.allSettled(selected.map(async (item) => {
        const subject = await getBangumiSubject(item.subject_id, options);
        const mediaType = mediaTypeForBangumiId(item.subject_type, subject.platform, subjectTags(subject));
        if (!mediaType || !selectedTypes.has(mediaType)) return null;
        const [existing] = await getDb().select().from(userSubjects).where(and(eq(userSubjects.userKey, key), eq(userSubjects.subjectId, item.subject_id), eq(userSubjects.source, "bangumi"))).limit(1);
        const remoteTags = [...subjectTags(subject), ...(item.tags || item.tag || [])].filter(Boolean).slice(0, 30);
        const remoteImage = subjectImage(subject) || null;
        const data = {
          type: mediaType,
          subjectId: item.subject_id,
          title: existing?.title || subject.name_cn || subject.name,
          jp: existing?.jp || subject.name,
          note: existing?.note ?? item.comment ?? "",
          progress: mediaType === "music" ? Math.max(0, Number(item.vol_status) || 0) : Math.max(0, Number(item.ep_status) || 0),
          total: existing?.total ?? (mediaType === "music" ? 1 : mediaType === "game" ? 100 : subject.eps || 12),
          status: statusForCollectionType(item.type ?? item.collection_type),
          kind: "coral",
          score: Number.isInteger(item.rate) && item.rate! >= 1 && item.rate! <= 10 ? item.rate : null,
          next: existing?.next ?? null,
          image: existing?.image || remoteImage,
          globalScore: existing?.globalScore ?? (subjectScore(subject) || null),
          source: existing?.source || "bangumi",
          collection: "",
          tags: existing?.tags || JSON.stringify(remoteTags),
          musicAlbum: "",
          musicArtist: "",
          lyricist: "",
          composer: "",
          animeSong: mediaType === "music" && subjectTags(subject).some((tag) => /动画|原声|主题曲|片尾|片头/.test(tag)),
          metadata: JSON.stringify(mergeBangumiSource(existing?.metadata, item.subject_id)),
          updatedAt: new Date(),
        };
        if (existing) {
          await getDb().update(userSubjects).set(data).where(and(eq(userSubjects.id, existing.id), eq(userSubjects.userKey, key)));
          return { mediaId: existing.id, subjectId: item.subject_id, imported: true };
        }
        const [created] = await getDb().insert(userSubjects).values({ ...data, userKey: key }).returning({ id: userSubjects.id });
        return { mediaId: created?.id, subjectId: item.subject_id, imported: true };
      }));
      const imported = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
      return Response.json({ ok: true, provider: "bangumi", authMode: options.userToken ? "user_token" : "public", mode: "import", requested: selected.length, synced: imported.length, failed: selected.length - imported.length, updates: imported, errors: [] }, { headers: { "cache-control": "no-store" } });
    }
    const results = await Promise.allSettled(rows.filter((row) => row.subjectId).map(async (row) => {
      const subject = await getBangumiSubject(row.subjectId!, options);
      const currentMetadata = (() => {
        try { return normalizeMediaMetadata(JSON.parse(row.metadata)); } catch { return normalizeMediaMetadata(); }
      })();
      const nextMetadata = normalizeMediaMetadata({
        ...currentMetadata,
        ...(syncFields.overview ? { overview: subject.summary || "", overviewOverride: false } : {}),
      });
      const next = {
        ...(syncFields.title ? { title: subject.name_cn || subject.name, jp: subject.name } : {}),
        total: subject.eps && subject.eps > 0 ? subject.eps : row.total,
        ...(syncFields.cover ? { image: subjectImage(subject) || row.image } : {}),
        ...(syncFields.score ? { globalScore: subjectScore(subject) || row.globalScore } : {}),
        metadata: JSON.stringify(nextMetadata),
        source: "bangumi",
        updatedAt: new Date(),
      };
      await getDb().update(userSubjects).set(next).where(and(eq(userSubjects.id, row.id), eq(userSubjects.userKey, key)));
      return { mediaId: row.id, subjectId: row.subjectId, title: subject.name_cn || subject.name, jp: subject.name, image: subjectImage(subject) || row.image, globalScore: subjectScore(subject) || row.globalScore, overview: subject.summary || "", metadata: nextMetadata, total: next.total, updatedAt: next.updatedAt.getTime() };
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
