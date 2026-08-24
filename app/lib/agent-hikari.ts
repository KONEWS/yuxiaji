import { fetchSubjectDetail, highResCoverUrl, syncBangumi } from "./client-api";
import type { Anime, BangumiDetail, MediaType } from "./tracker-types";

type BangumiSyncResponse = {
  updates?: Array<{ mediaId: number; jp?: string; total?: number; image?: string; globalScore?: number; updatedAt?: number }>;
  synced?: number;
  failed?: number;
};

async function refreshViaSyncApi(anime: Anime[], syncTypes: MediaType[], userToken?: string) {
  if (!syncTypes.length) throw new Error("请先选择需要使用 Bangumi 的媒体类型");
  const payload = await syncBangumi({ types: syncTypes, userToken }) as BangumiSyncResponse;
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (!updates.length) return null;
  const byMediaId = new Map(updates.map((item) => [item.mediaId, item]));
  return {
    count: updates.length,
    anime: anime.map((item) => {
      const update = byMediaId.get(item.id);
      if (!update) return item;
      return { ...item, jp: item.jp || update.jp || "", total: update.total || item.total, image: (item.mediaType || "anime") === "anime" ? highResCoverUrl(update.jp || item.jp || item.title) : (update.image || item.image), globalScore: update.globalScore || item.globalScore, updatedAt: update.updatedAt || item.updatedAt };
    }),
  };
}

async function refreshViaPublicSubjects(anime: Anime[], syncTypes: MediaType[]) {
  if (!syncTypes.length) throw new Error("请先在设置中选择至少一种 Bangumi 同步类型");
  const linked = anime.filter((item) => item.subjectId && syncTypes.includes(item.mediaType || "anime"));
  if (!linked.length) throw new Error("所选类型里还没有绑定 Bangumi 的条目");
  const results = await Promise.allSettled(linked.map((item) => fetchSubjectDetail<BangumiDetail>(item.subjectId, item.title, item.mediaType || "anime")));
  const details = new Map<number, BangumiDetail>();
  results.forEach((result, index) => { if (result.status === "fulfilled") details.set(linked[index].id, result.value); });
  if (!details.size) throw new Error("Bangumi 暂时无法同步");
  const updated = anime.map((item) => {
    const detail = details.get(item.id);
    if (!detail) return item;
    return { ...item, jp: item.jp || detail.jp, total: detail.total || item.total, image: (item.mediaType || "anime") === "anime" ? highResCoverUrl(detail.jp || detail.title) : (detail.image || item.image), globalScore: detail.score || item.globalScore };
  });
  return { count: details.size, anime: updated };
}

export async function refreshBangumiRecords(anime: Anime[], syncTypes: MediaType[], userToken?: string) {
  try {
    const synced = await refreshViaSyncApi(anime, syncTypes, userToken);
    if (synced) return synced;
  } catch {
    // Keep the public read-only path available while the sync API is unavailable.
  }
  return refreshViaPublicSubjects(anime, syncTypes);
}
