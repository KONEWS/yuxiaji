import { bangumiRequestOptions, getBangumiSubject, searchBangumiSubjects, subjectImage, subjectScore, subjectTags, subjectTitle, type BangumiRequestOptions, type BangumiSubjectDetail, type BangumiSubjectSummary } from "./bangumi-api";
import { getTmdbMediaDetail, searchTmdbMedia, type TmdbMediaResult, type TmdbMediaType } from "./tmdb-api";

export type ProviderMediaType = "anime" | "game" | "light_novel" | "manga" | "music" | "movie" | "tv";

export type MediaProviderResult = {
  id: number;
  title: string;
  originalTitle: string;
  year?: number;
  coverImage: string;
  backdropImage: string;
  overview: string;
  rating: number;
  genres: string[];
  tmdbId?: number;
  source: "bangumi" | "tmdb";
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
  metadata?: TmdbMediaResult["metadata"];
};

export type MediaProviderDetail = MediaProviderResult & {
  summary: string;
  platform: string;
  ratingTotal: number;
  rank?: number;
  tags: string[];
};

function yearFrom(date?: string) {
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

export async function searchMedia(query: string, type: ProviderMediaType, options: BangumiRequestOptions = {}) {
  if (type === "movie" || type === "tv") return searchTmdbMedia(query, type, options);
  const subjects = await searchBangumiSubjects(query, type, options);
  return subjects.map(bangumiResult);
}

export async function getMediaDetail(id: number, type: ProviderMediaType, options: BangumiRequestOptions = {}) {
  if (type === "movie" || type === "tv") return tmdbDetail(await getTmdbMediaDetail(id, type, options), type);
  return bangumiDetail(await getBangumiSubject(id, options));
}

export async function resolveMediaId(query: string, type: ProviderMediaType, options: BangumiRequestOptions = {}) {
  const results = await searchMedia(query, type, options);
  return results[0]?.id;
}
