import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { bangumiAccount, userSubjects } from "../../../../../db/schema";
import { decryptBangumiToken } from "../../../../lib/bangumi-account";
import { getAllBangumiUserCollections, getBangumiSubject, markBangumiAnimeProgress, subjectImage, subjectScore, subjectTags, updateBangumiCollection, type BangumiCollectionUpdate } from "../../../../lib/bangumi-api";
import { csrfFailure, requireAdminSession } from "../../../../lib/admin-auth";
import { getCurrentUser } from "../../../../lib/current-user";

const SUPPORTED_TYPES = new Set(["anime", "game", "light_novel", "manga", "music"]);

function mediaTypeForBangumiId(value: unknown) {
  return value === 2 ? "anime" : value === 4 ? "game" : value === 3 ? "music" : value === 1 ? "light_novel" : null;
}

function statusForCollectionType(value: unknown) {
  return value === 1 ? "wish" : value === 2 ? "finished" : value === 3 ? "watching" : value === 4 ? "library" : value === 5 ? "dropped" : "watching";
}

function parseMetadata(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function collectionTypeForStatus(status: string): 1 | 2 | 3 | 4 | 5 {
  return status === "wish" ? 1 : status === "finished" ? 2 : status === "library" ? 4 : status === "dropped" ? 5 : 3;
}

function parseLocalTags(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? Array.from(new Set(parsed.map((tag) => String(tag).trim()).filter((tag) => tag && !/\s/.test(tag)))).slice(0, 20) : [];
  } catch {
    return [];
  }
}

async function pushToBangumi(input: { userKey: string; token: string; adminId: number; types: Set<string> }) {
  const rows = await getDb().select().from(userSubjects).where(and(eq(userSubjects.userKey, input.userKey), eq(userSubjects.source, "bangumi")));
  const candidates = rows.filter((item) => item.subjectId && SUPPORTED_TYPES.has(item.type) && input.types.has(item.type));
  const updates: Array<{ mediaId: number; subjectId: number; episodesMarked: number }> = [];
  const errors: Array<{ subjectId: number; error: string }> = [];
  for (const item of candidates) {
    const subjectId = item.subjectId!;
    try {
      const payload: BangumiCollectionUpdate = {
        type: collectionTypeForStatus(item.status),
        rate: item.score && item.score >= 1 && item.score <= 10 ? item.score : 0,
        comment: item.note,
        tags: parseLocalTags(item.tags),
      };
      if (item.type === "light_novel") payload.vol_status = Math.max(0, item.progress);
      if (item.type === "manga") payload.ep_status = Math.max(0, item.progress);
      await updateBangumiCollection(subjectId, payload, { userToken: input.token });
      const episodesMarked = item.type === "anime" ? await markBangumiAnimeProgress(subjectId, item.progress, { userToken: input.token }) : 0;
      updates.push({ mediaId: item.id, subjectId, episodesMarked });
    } catch (error) {
      errors.push({ subjectId, error: error instanceof Error ? error.message : "同步失败" });
    }
  }
  const lastSyncAt = new Date();
  await getDb().update(bangumiAccount).set({ lastSyncAt, updatedAt: lastSyncAt }).where(eq(bangumiAccount.adminId, input.adminId));
  return { ok: true, provider: "bangumi", direction: "push", requested: candidates.length, synced: updates.length, failed: errors.length, updates, errors, lastSyncAt: lastSyncAt.toISOString() };
}

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  try {
    const [binding] = await getDb().select().from(bangumiAccount).where(eq(bangumiAccount.adminId, current.account.id)).limit(1);
    if (!binding) return Response.json({ error: "尚未绑定 Bangumi 账号" }, { status: 404 });
    const token = await decryptBangumiToken(binding.tokenCiphertext);
    const body = await request.json().catch(() => ({})) as { direction?: unknown; types?: unknown };
    const direction = body.direction === "push" ? "push" : "pull";
    const requestedTypes = Array.isArray(body.types) ? body.types.map((value) => String(value)).filter((value) => SUPPORTED_TYPES.has(value)) : [];
    const selectedTypes = new Set(requestedTypes.length ? requestedTypes : Array.from(SUPPORTED_TYPES));
    if (direction === "push") {
      const result = await pushToBangumi({ userKey: getCurrentUser(request), token, adminId: current.account.id, types: selectedTypes });
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    }
    const collections = await getAllBangumiUserCollections(binding.username, { userToken: token }, 1000);
    const key = getCurrentUser(request);
    const imported: Array<{ mediaId: number | undefined; subjectId: number; action: "created" | "updated" }> = [];
    const errors: Array<{ subjectId: number; error: string }> = [];
    for (const item of collections) {
      const type = mediaTypeForBangumiId(item.subject_type);
      if (!type || !SUPPORTED_TYPES.has(type) || !selectedTypes.has(type)) continue;
      try {
        const subject = await getBangumiSubject(item.subject_id, { userToken: token });
        const tags = [...subjectTags(subject), ...(item.tags || item.tag || [])].filter(Boolean).slice(0, 30);
        const now = new Date();
        const [existing] = await getDb().select().from(userSubjects).where(and(eq(userSubjects.userKey, key), eq(userSubjects.subjectId, item.subject_id), eq(userSubjects.source, "bangumi"))).limit(1);
        const metadata = existing ? parseMetadata(existing.metadata) : {};
        const data = {
          type,
          subjectId: item.subject_id,
          title: subject.name_cn || subject.name,
          jp: subject.name || "",
          note: item.comment || "",
          progress: type === "music"
            ? (Number.isInteger(item.vol_status) && item.vol_status! >= 0 ? item.vol_status : 0)
            : (Number.isInteger(item.ep_status) && item.ep_status! >= 0 ? item.ep_status : 0),
          total: type === "music" ? Math.max(1, subject.volumes || 1) : type === "game" ? 100 : Math.max(1, subject.eps || subject.volumes || 12),
          status: statusForCollectionType(item.type ?? item.collection_type),
          score: Number.isInteger(item.rate) && item.rate! >= 1 && item.rate! <= 10 ? item.rate : null,
          next: null,
          image: subjectImage(subject) || null,
          globalScore: subjectScore(subject) || null,
          source: "bangumi",
          tags: JSON.stringify(tags),
          metadata: JSON.stringify({ ...metadata, provider: "bangumi", bangumiUserId: binding.bangumiUserId, syncedAt: now.toISOString(), commentUpdatedAt: item.updated_at || null, volumes: subject.volumes || null }),
          updatedAt: now,
        };
        if (existing) {
          await getDb().update(userSubjects).set(data).where(and(eq(userSubjects.id, existing.id), eq(userSubjects.userKey, key), eq(userSubjects.source, "bangumi")));
          imported.push({ mediaId: existing.id, subjectId: item.subject_id, action: "updated" });
        } else {
          const [created] = await getDb().insert(userSubjects).values({ ...data, userKey: key }).returning({ id: userSubjects.id });
          imported.push({ mediaId: created?.id, subjectId: item.subject_id, action: "created" });
        }
      } catch (error) {
        errors.push({ subjectId: item.subject_id, error: error instanceof Error ? error.message : "同步失败" });
      }
    }
    const lastSyncAt = new Date();
    await getDb().update(bangumiAccount).set({ lastSyncAt, updatedAt: lastSyncAt }).where(eq(bangumiAccount.adminId, current.account.id));
    return Response.json({ ok: true, provider: "bangumi", direction: "pull", requested: collections.length, synced: imported.length, failed: errors.length, updates: imported, errors, lastSyncAt: lastSyncAt.toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "Bangumi 收藏同步失败", details: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
