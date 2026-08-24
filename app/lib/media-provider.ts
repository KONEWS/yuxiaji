import { bangumiRequestOptions, getBangumiSubject, searchBangumiSubjects, subjectImage, subjectScore, subjectTags, subjectTitle, type BangumiRequestOptions, type BangumiSubjectDetail, type BangumiSubjectSummary } from "./bangumi-api";
import { getTmdbMediaDetail, searchTmdbMedia, type TmdbMediaResult, type TmdbMediaType } from "./tmdb-api";
import { normalizeMediaMetadata, type MediaMetadata } from "./constants";
import { getVndbVisualNovel, normalizeVndbId, searchVndbVisualNovels, vndbNumericId, type VndbVisualNovel } from "./vndb-api";

export type ProviderMediaType = "anime" | "game" | "light_novel" | "manga" | "music" | "movie" | "tv";
export type MediaProviderName = "bangumi" | "vndb" | "tmdb";
export type ProviderLookup = { provider?: MediaProviderName; externalId?: string; vndbId?: string };

export type MediaProviderResult = {
  id: number;
  externalId?: string;
  title: string;
  originalTitle: string;
  year?: number;
  coverImage: string;
  backdropImage: string;
  overview: string;
  rating: number;
  genres: string[];
  tmdbId?: number;
  source: MediaProviderName;
  date: string;
  total: number;
  image: string;
  jp: string;
  director?: string;
  actors?: string[];
  country?: string;
  runtime?: number;
  seasons?: number;
  episodes?: number;
  metadata?: MediaMetadata;
};

export type MediaProviderDetail = MediaProviderResult & {
  summary: string;
  platform: string;
  ratingTotal: number;
  rank?: number;
  tags: string[];
};

function yearFrom(date?: string | null) {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

function bangumiResult(subject: BangumiSubjectSummary): MediaProviderResult {
  const image = subjectImage(subject);
  return {
    id: subject.id,
    title: subjectTitle(subject),
    originalTitle: subject.name,
    year: yearFrom(subject.date),
    coverImage: image,
    backdropImage: "",
    overview: "",
    rating: 0,
    genres: [],
    source: "bangumi",
    date: subject.date || "",
    total: subject.eps || 0,
    image,
    jp: subject.name,
  };
}

function bangumiDetail(subject: BangumiSubjectDetail): MediaProviderDetail {
  const base = bangumiResult(subject);
  const rating = subjectScore(subject);
  const tags = subjectTags(subject);
  return {
    ...base,
    overview: subject.summary || "",
    rating,
    genres: tags,
    summary: subject.summary || "",
    platform: subject.platform || "",
    ratingTotal: Number(subject.rating?.total) || 0,
    rank: Number(subject.rating?.rank || subject.collection?.rank) || undefined,
    tags,
  };
}

function vndbTitle(subject: VndbVisualNovel) {
  return subject.title?.trim() || subject.alttitle?.trim() || "未命名视觉小说";
}

function vndbTags(subject: VndbVisualNovel) {
  return (subject.tags || []).map((tag) => tag.name?.trim() || "").filter(Boolean).slice(0, 30);
}

function vndbRating(subject: VndbVisualNovel) {
  const value = Number(subject.average ?? subject.rating);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 10 ? value / 10 : value;
}

function vndbMetadata(subject: VndbVisualNovel, id: string, genres: string[]): MediaMetadata {
  const externalId = normalizeVndbId(id);
  const platforms = Array.isArray(subject.platforms) ? subject.platforms.map(String).filter(Boolean).slice(0, 30) : [];
  const developers = (subject.developers || []).map((developer) => developer.name?.trim() || "").filter(Boolean).slice(0, 30);
  return normalizeMediaMetadata({
    director: developers.join(" / "),
    actors: [],
    year: yearFrom(subject.released),
    region: "",
    runtime: Number(subject.length_minutes) > 0 ? Number(subject.length_minutes) : undefined,
    overview: subject.description || "",
    originalTitle: subject.alttitle || subject.title || "",
    genres,
    provider: "vndb",
    vndbId: externalId,
    vndbUrl: `https://vndb.org/${externalId}`,
    platforms,
    developers,
  });
}

function vndbResult(subject: VndbVisualNovel): MediaProviderResult | null {
  const externalId = normalizeVndbId(subject.id);
  const id = vndbNumericId(externalId);
  if (!id) return null;
  const title = vndbTitle(subject);
  const originalTitle = subject.alttitle?.trim() || subject.title?.trim() || title;
  const image = subject.image?.url?.trim() || "";
  const genres = vndbTags(subject);
  return {
    id,
    externalId,
    title,
    originalTitle,
    year: yearFrom(subject.released),
    coverImage: image,
    backdropImage: "",
    overview: subject.description || "",
    rating: vndbRating(subject),
    genres,
    source: "vndb",
    date: subject.released || "",
    total: 100,
    image,
    jp: originalTitle,
    runtime: Number(subject.length_minutes) > 0 ? Number(subject.length_minutes) : undefined,
    metadata: vndbMetadata(subject, externalId, genres),
  };
}

function vndbDetail(subject: VndbVisualNovel): MediaProviderDetail {
  const base = vndbResult(subject);
  if (!base) throw new Error("VNDB 返回了无效条目 ID");
  const tags = vndbTags(subject);
  return {
    ...base,
    summary: subject.description || "",
    platform: Array.isArray(subject.platforms) ? subject.platforms.filter(Boolean).join(" / ") : "",
    ratingTotal: Number(subject.votecount) || 0,
    tags,
  };
}

function tmdbDetail(result: TmdbMediaResult, type: TmdbMediaType): MediaProviderDetail {
  return {
    ...result,
    summary: result.overview,
    platform: type === "movie" ? "电影" : "电视剧",
    ratingTotal: 0,
    tags: result.genres,
  };
}

export function providerOptions(request: Request): BangumiRequestOptions {
  return bangumiRequestOptions(request);
}

async function searchGameMedia(query: string, options: BangumiRequestOptions) {
  const attempts = await Promise.allSettled([
    searchBangumiSubjects(query, "game", options),
    searchVndbVisualNovels(query, options),
  ]);
  const bangumi = attempts[0].status === "fulfilled" ? attempts[0].value.map(bangumiResult) : [];
  const vndb = attempts[1].status === "fulfilled" ? attempts[1].value.map(vndbResult).filter((item): item is MediaProviderResult => Boolean(item)) : [];
  if (!bangumi.length && !vndb.length) {
    const failure = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")?.reason;
    if (failure) throw failure;
  }
  const combined: MediaProviderResult[] = [];
  for (let index = 0; index < Math.max(bangumi.length, vndb.length); index += 1) {
    if (bangumi[index]) combined.push(bangumi[index]);
    if (vndb[index]) combined.push(vndb[index]);
  }
  const seen = new Set<string>();
  return combined.filter((item) => {
    const key = `${item.source}:${item.externalId || item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchMedia(query: string, type: ProviderMediaType, options: BangumiRequestOptions = {}) {
  if (type === "movie" || type === "tv") return searchTmdbMedia(query, type, options);
  if (type === "game") return searchGameMedia(query, options);
  const subjects = await searchBangumiSubjects(query, type, options);
  return subjects.map(bangumiResult);
}

export async function getMediaDetail(id: number, type: ProviderMediaType, options: BangumiRequestOptions = {}, lookup: ProviderLookup = {}) {
  if (lookup.provider === "vndb" || lookup.externalId || lookup.vndbId) {
    const externalId = normalizeVndbId(lookup.externalId || lookup.vndbId || `v${id}`);
    if (!externalId) throw new Error("VNDB 条目 ID 无效");
    return vndbDetail(await getVndbVisualNovel(externalId, options));
  }
  if (type === "movie" || type === "tv") return tmdbDetail(await getTmdbMediaDetail(id, type, options), type);
  return bangumiDetail(await getBangumiSubject(id, options));
}

export async function resolveMediaId(query: string, type: ProviderMediaType, options: BangumiRequestOptions = {}, lookup: ProviderLookup = {}) {
  if (lookup.provider === "vndb") {
    const result = (await searchVndbVisualNovels(query, options)).map(vndbResult).find(Boolean);
    return result?.id;
  }
  const results = await searchMedia(query, type, options);
  return results[0]?.id;
}
