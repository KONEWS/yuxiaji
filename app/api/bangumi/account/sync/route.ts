import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { bangumiAccount, userSubjects } from "../../../../../db/schema";
import { decryptBangumiToken } from "../../../../lib/bangumi-account";
import { getAllBangumiUserCollections, getBangumiSubject, markBangumiAnimeProgress, subjectImage, subjectScore, subjectTags, updateBangumiCollection, type BangumiCollectionUpdate } from "../../../../lib/bangumi-api";
import { csrfFailure, requireAdminSession } from "../../../../lib/admin-auth";
import { getCurrentUser } from "../../../../lib/current-user";

const SUPPORTED_TYPES = new Set(["anime", "game", "light_novel", "manga", "music"]);

function mediaTypeForBangumiId(value: unknown, platform = "", tags: string[] = []) {
  if (value === 1) {
    const descriptor = `${platform} ${tags.join(" ")}`.toLowerCase();
    return /漫画|コミック|manga|manhwa|manhua|webtoon/.test(descriptor) ? "manga" : "light_novel";
  }
  return value === 2 ? "anime" : value === 4 ? "game" : value === 3 ? "music" : null;
}

function canContainSelectedType(subjectType: unknown, selectedTypes: Set<string>) {
  if (subjectType === 1) return selectedTypes.has("light_novel") || selectedTypes.has("manga");
  const type = mediaTypeForBangumiId(subjectType);
  return Boolean(type && selectedTypes.has(type));
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

function metadataWithBangumiSource(value: string | undefined, subjectId: number, type: string) {
  const metadata = parseMetadata(value || "{}");
  const currentSources = metadata.sources && typeof metadata.sources === "object" && !Array.isArray(metadata.sources)
    ? metadata.sources as Record<string, unknown>
    : {};
  return {
    ...metadata,
    sources: { ...currentSources, bangumi: String(subjectId) },
    ...(type === "light_novel" && metadata.bookKind !== "book" ? { bookKind: "light_novel" } : {}),
  };
}

function linkedBangumiId(row: typeof userSubjects.$inferSelect) {
  if (row.source === "bangumi" && row.subjectId && row.subjectId > 0) return row.subjectId;
  const sourceId = (parseMetadata(row.metadata).sources as Record<string, unknown> | undefined)?.bangumi;
  const numericId = Number(sourceId);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : undefined;
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
  const rows = await getDb().select().from(userSubjects).where(eq(userSubjects.userKey, input.userKey));
  const candidates = rows.map((item) => ({ item, subjectId: linkedBangumiId(item) })).filter((candidate): candidate is { item: typeof userSubjects.$inferSelect; subjectId: number } => Boolean(candidate.subjectId && SUPPORTED_TYPES.has(candidate.item.type) && input.types.has(candidate.item.type)));
  const updates: Array<{ mediaId: number; subjectId: number; episodesMarked: number }> = [];
  const errors: Array<{ subjectId: number; error: string }> = [];
  for (const candidate of candidates) {
    const { item, subjectId } = candidate;
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
    const localRows = await getDb().select().from(userSubjects).where(eq(userSubjects.userKey, key));
    const rowsByBangumiId = new Map<number, typeof userSubjects.$inferSelect>();
    for (const row of localRows) {
      const linkedId = linkedBangumiId(row);
      if (!linkedId) continue;
      const current = rowsByBangumiId.get(linkedId);
      if (!current || (current.source !== "bangumi" && row.source === "bangumi")) rowsByBangumiId.set(linkedId, row);
    }
    const imported: Array<{ mediaId: number | undefined; subjectId: number; action: "created" | "updated" }> = [];
    const errors: Array<{ subjectId: number; error: string }> = [];
    for (const item of collections) {
      if (!canContainSelectedType(item.subject_type, selectedTypes)) continue;
      try {
        let subject = item.subject;
        const summaryTags = subject ? subjectTags(subject) : [];
        const needsBookDetail = item.subject_type === 1 && !/漫画|コミック|manga|manhwa|manhua|webtoon|轻小说|小說|小说|novel/i.test(summaryTags.join(" "));
        if (!subject || needsBookDetail) subject = await getBangumiSubject(item.subject_id, { userToken: token });
        const subjectTagNames = subjectTags(subject);
        const type = mediaTypeForBangumiId(item.subject_type, subject.platform, subjectTagNames);
        if (!type || !SUPPORTED_TYPES.has(type) || !selectedTypes.has(type)) continue;
        const tags = [...subjectTagNames, ...(item.tags || item.tag || [])].filter(Boolean).slice(0, 30);
        const now = new Date();
        const existing = rowsByBangumiId.get(item.subject_id);
        const resolvedType = existing && SUPPORTED_TYPES.has(existing.type) ? existing.type : type;
        const metadata = metadataWithBangumiSource(existing?.metadata, item.subject_id, resolvedType);
        const remoteTitle = subject.name_cn || subject.name;
        const remoteImage = subjectImage(subject) || null;
        const remoteGlobalScore = subjectScore(subject) || null;
        const data = {
          type: resolvedType,
          subjectId: item.subject_id,
          // Account import updates collection state. Public metadata refresh is
          // a separate, user-configurable action, so existing manual fields
          // must not be overwritten here.
          title: existing?.title || remoteTitle,
          jp: existing?.jp || subject.name || "",
          note: existing?.note ?? item.comment ?? "",
          progress: resolvedType === "music"
            ? (Number.isInteger(item.vol_status) && item.vol_status! >= 0 ? item.vol_status : 0)
            : (Number.isInteger(item.ep_status) && item.ep_status! >= 0 ? item.ep_status : 0),
          total: existing?.total ?? (resolvedType === "music" ? Math.max(1, subject.volumes || 1) : resolvedType === "game" ? 100 : Math.max(1, subject.eps || subject.volumes || 12)),
          status: statusForCollectionType(item.type ?? item.collection_type),
          score: Number.isInteger(item.rate) && item.rate! >= 1 && item.rate! <= 10 ? item.rate : null,
          next: existing?.next ?? null,
          image: existing?.image ?? remoteImage,
          globalScore: existing?.globalScore ?? remoteGlobalScore,
          source: existing?.source || "bangumi",
          tags: existing?.tags || JSON.stringify(tags),
          metadata: JSON.stringify(metadata),
          updatedAt: now,
        };
        if (existing) {
          await getDb().update(userSubjects).set(data).where(and(eq(userSubjects.id, existing.id), eq(userSubjects.userKey, key)));
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
    return Response.json({ ok: true, provider: "bangumi", direction: "pull", requested: imported.length + errors.length, fetched: collections.length, synced: imported.length, failed: errors.length, skipped: collections.length - imported.length - errors.length, updates: imported, errors, lastSyncAt: lastSyncAt.toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "Bangumi 收藏同步失败", details: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
