import type { MediaMetadata } from "./constants";

export const ANILIST_API_BASE = "https://graphql.anilist.co";

export type AniListRequestOptions = { signal?: AbortSignal };
export type AniListMedia = {
  id: number;
  idMal?: number;
  title?: { romaji?: string; english?: string; native?: string; userPreferred?: string };
  description?: string | null;
  startDate?: { year?: number; month?: number; day?: number };
  episodes?: number | null;
  volumes?: number | null;
  chapters?: number | null;
  averageScore?: number | null;
  genres?: string[];
  tags?: Array<{ name?: string }>;
  coverImage?: { extraLarge?: string; large?: string; medium?: string };
  format?: string | null;
  countryOfOrigin?: string | null;
  status?: string | null;
};

export class AniListApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "AniListApiError"; }
}

const MEDIA_FIELDS = `
  id idMal title { romaji english native userPreferred }
  description startDate { year month day } episodes volumes chapters averageScore
  genres tags { name } coverImage { extraLarge large medium } format countryOfOrigin status
`;

async function request<T>(query: string, variables: Record<string, unknown>, options: AniListRequestOptions = {}) {
  const response = await fetch(ANILIST_API_BASE, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: options.signal || AbortSignal.timeout(9000),
  });
  const payload = await response.json().catch(() => ({})) as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || payload.errors?.length) {
    throw new AniListApiError(`AniList 返回 ${response.status}${payload.errors?.[0]?.message ? `：${payload.errors[0].message}` : ""}`, response.status);
  }
  return payload.data as T;
}

export async function searchAniList(query: string, media: "ANIME" | "MANGA", options: AniListRequestOptions = {}) {
  const data = await request<{ Page?: { media?: AniListMedia[] } }>(`query ($search: String!, $type: MediaType!) { Page(page: 1, perPage: 8) { media(search: $search, type: $type, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} } } }`, { search: query.trim().slice(0, 80), type: media }, options);
  return data.Page?.media || [];
}

export async function getAniListMedia(id: string | number, options: AniListRequestOptions = {}) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) throw new AniListApiError("AniList 条目 ID 无效", 400);
  const data = await request<{ Media?: AniListMedia }>(`query ($id: Int!) { Media(id: $id) { ${MEDIA_FIELDS} } }`, { id: numericId }, options);
  if (!data.Media) throw new AniListApiError(`AniList 条目 ${id} 不存在`, 404);
  return data.Media;
}

export function aniListTitle(item: AniListMedia) {
  return item.title?.userPreferred?.trim() || item.title?.english?.trim() || item.title?.romaji?.trim() || item.title?.native?.trim() || "未命名条目";
}

export function aniListOriginalTitle(item: AniListMedia) {
  return item.title?.native?.trim() || item.title?.romaji?.trim() || item.title?.english?.trim() || aniListTitle(item);
}

export function aniListImage(item: AniListMedia) {
  return item.coverImage?.extraLarge || item.coverImage?.large || item.coverImage?.medium || "";
}

export function aniListMetadata(item: AniListMedia): MediaMetadata {
  const tags = [...(item.genres || []), ...(item.tags || []).map((tag) => tag.name || "")].filter(Boolean).slice(0, 30);
  return {
    director: "", actors: [], region: item.countryOfOrigin || "", year: item.startDate?.year,
    episodes: item.episodes || undefined, overview: (item.description || "").replace(/<[^>]+>/g, "").trim(),
    originalTitle: aniListOriginalTitle(item), genres: tags, sources: { anilist: String(item.id) },
  };
}
