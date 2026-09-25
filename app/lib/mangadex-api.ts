import type { MediaMetadata } from "./constants";

export const MANGADEX_API_BASE = "https://api.mangadex.org";
export type MangaDexRequestOptions = { signal?: AbortSignal };
type MangaDexAttributes = { title?: Record<string, string>; altTitles?: Array<Record<string, string>>; description?: Record<string, string>; year?: number; lastVolume?: string; lastChapter?: string; status?: string; tags?: Array<{ attributes?: { name?: Record<string, string> } }> };
export type MangaDexManga = { id: string; attributes?: MangaDexAttributes; relationships?: Array<{ type?: string; id?: string; attributes?: { fileName?: string } }> };

export class MangaDexApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "MangaDexApiError"; }
}

async function request<T>(path: string, options: MangaDexRequestOptions = {}) {
  const response = await fetch(`${MANGADEX_API_BASE}${path}`, { headers: { accept: "application/json" }, signal: options.signal || AbortSignal.timeout(9000) });
  const payload = await response.json().catch(() => ({})) as T & { errors?: Array<{ detail?: string }> };
  if (!response.ok) throw new MangaDexApiError(`MangaDex 返回 ${response.status}${payload.errors?.[0]?.detail ? `：${payload.errors[0].detail}` : ""}`, response.status);
  return payload;
}

export async function searchMangaDex(query: string, options: MangaDexRequestOptions = {}) {
  const params = new URLSearchParams({ title: query.trim().slice(0, 80), limit: "8", "contentRating[]": "safe", "includes[]": "cover_art" });
  const payload = await request<{ data?: MangaDexManga[] }>(`/manga?${params.toString()}`, options);
  return payload.data || [];
}

export async function getMangaDexManga(id: string, options: MangaDexRequestOptions = {}) {
  const payload = await request<{ data?: MangaDexManga }>(`/manga/${encodeURIComponent(id)}?includes[]=cover_art`, options);
  if (!payload.data) throw new MangaDexApiError(`MangaDex 条目 ${id} 不存在`, 404);
  return payload.data;
}

export function mangaDexTitle(item: MangaDexManga) {
  const title = item.attributes?.title || {};
  return title.zh || title["zh-hk"] || title.en || title.ja || Object.values(title)[0] || "未命名漫画";
}

export function mangaDexOriginalTitle(item: MangaDexManga) {
  const title = item.attributes?.title || {};
  return title.ja || title.en || Object.values(title)[0] || mangaDexTitle(item);
}

export function mangaDexImage(item: MangaDexManga) {
  const cover = item.relationships?.find((relationship) => relationship.type === "cover_art");
  return cover?.id && cover.attributes?.fileName ? `https://uploads.mangadex.org/covers/${item.id}/${cover.attributes.fileName}.256.jpg` : "";
}

export function mangaDexMetadata(item: MangaDexManga): MediaMetadata {
  const attributes = item.attributes || {};
  const description = attributes.description?.zh || attributes.description?.en || Object.values(attributes.description || {})[0] || "";
  const tags = (attributes.tags || []).map((tag) => tag.attributes?.name?.zh || tag.attributes?.name?.en || Object.values(tag.attributes?.name || {})[0] || "").filter(Boolean).slice(0, 30);
  return { director: "", actors: [], region: "", year: attributes.year, overview: description, originalTitle: mangaDexOriginalTitle(item), genres: tags, sources: { mangadex: item.id }, identifiers: { ...(attributes.lastChapter ? { lastChapter: attributes.lastChapter } : {}) } };
}
