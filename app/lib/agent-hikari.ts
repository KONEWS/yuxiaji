import { fetchSubjectDetail, highResCoverUrl, syncBangumi } from "./client-api";
import { normalizeMediaMetadata, normalizeSyncSettings, type SyncSettings } from "./constants";
import type { Anime, BangumiDetail, MediaType } from "./tracker-types";

type BangumiSyncResponse = {
  updates?: Array<{ mediaId: number; title?: string; jp?: string; total?: number; image?: string; globalScore?: number; overview?: string; metadata?: unknown; updatedAt?: number }>;
  synced?: number;
  failed?: number;
};

async function refreshViaSyncApi(anime: Anime[], syncTypes: MediaType[], userToken: string | undefined, syncSettings: SyncSettings) {
  if (!syncTypes.length) throw new Error("请先选择需要使用 Bangumi 的媒体类型");
  const payload = await syncBangumi({ types: syncTypes, userToken, syncSettings }) as BangumiSyncResponse;
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (!updates.length) return null;
  const byMediaId = new Map(updates.map((item) => [item.mediaId, item]));
  const fields = syncSettings.bangumi;
  return {
    count: updates.length,
    anime: anime.map((item) => {
      const update = byMediaId.get(item.id);
      if (!update) return item;
      const metadata = normalizeMediaMetadata({
        ...item.metadata,
        ...(update.metadata && typeof update.metadata === "object" ? update.metadata : {}),
        ...(fields.overview && typeof update.overview === "string" ? { overview: update.overview, overviewOverride: false } : {}),
      });
      return {
        ...item,
        title: fields.title ? update.title || item.title : item.title,
        jp: fields.title ? update.jp || item.jp : item.jp,
        total: update.total || item.total,
        image: fields.cover ? ((item.mediaType || "anime") === "anime" ? highResCoverUrl(update.jp || item.jp || item.title) : (update.image || item.image)) : item.image,
        globalScore: fields.score ? update.globalScore ?? item.globalScore : item.globalScore,
        metadata,
        updatedAt: update.updatedAt || item.updatedAt,
      };
    }),
  };
}

async function refreshViaPublicSubjects(anime: Anime[], syncTypes: MediaType[], syncSettings: SyncSettings) {
  if (!syncTypes.length) throw new Error("请先在设置中选择至少一种 Bangumi 同步类型");
  const linked = anime.filter((item) => item.subjectId && item.source !== "vndb" && syncTypes.includes(item.mediaType || "anime"));
  if (!linked.length) throw new Error("所选类型里还没有绑定 Bangumi 的条目");
  const results = await Promise.allSettled(linked.map((item) => fetchSubjectDetail<BangumiDetail>(item.subjectId, item.title, item.mediaType || "anime")));
  const details = new Map<number, BangumiDetail>();
  results.forEach((result, index) => { if (result.status === "fulfilled") details.set(linked[index].id, result.value); });
  if (!details.size) throw new Error("Bangumi 暂时无法同步");
  const fields = syncSettings.bangumi;
  const updated = anime.map((item) => {
    const detail = details.get(item.id);
    if (!detail) return item;
    const metadata = normalizeMediaMetadata({
      ...item.metadata,
      ...(fields.overview ? { overview: detail.summary || "", overviewOverride: false } : {}),
      ...(detail.tags?.length ? { genres: detail.tags } : {}),
    });
    return {
      ...item,
      title: fields.title ? detail.title || item.title : item.title,
      jp: fields.title ? detail.jp || item.jp : item.jp,
      total: detail.total || item.total,
      image: fields.cover ? ((item.mediaType || "anime") === "anime" ? highResCoverUrl(detail.jp || detail.title) : (detail.image || item.image)) : item.image,
      globalScore: fields.score ? detail.score || item.globalScore : item.globalScore,
      metadata,
    };
  });
  return { count: details.size, anime: updated };
}

export async function refreshBangumiRecords(anime: Anime[], syncTypes: MediaType[], userToken?: string, rawSyncSettings?: SyncSettings) {
  const syncSettings = normalizeSyncSettings(rawSyncSettings);
  try {
    const synced = await refreshViaSyncApi(anime, syncTypes, userToken, syncSettings);
    if (synced) return synced;
  } catch {
    // Keep the public read-only path available while the sync API is unavailable.
  }
  return refreshViaPublicSubjects(anime, syncTypes, syncSettings);
}
