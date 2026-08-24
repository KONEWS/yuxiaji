import { env } from "cloudflare:workers";

export type TmdbMediaType = "movie" | "tv";

export type TmdbMediaResult = {
  id: number;
  title: string;
  originalTitle: string;
  year?: number;
  coverImage: string;
  backdropImage: string;
  overview: string;
  rating: number;
  genres: string[];
  tmdbId: number;
  source: "tmdb";
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
  metadata?: {
    director: string;
    actors: string[];
    year?: number;
    region: string;
    seasons?: number;
    episodes?: number;
    tmdbId: number;
    backdropImage: string;
    overview: string;
    originalTitle: string;
    genres: string[];
    runtime?: number;
    provider: "tmdb";
  };
};

export class TmdbApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TmdbApiError";
  }
}

type TmdbSearchItem = {
  id?: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  genre_ids?: number[];
};

type TmdbDetail = TmdbSearchItem & {
  genres?: Array<{ id?: number; name?: string }>;
  runtime?: number | null;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  origin_country?: string[];
  production_countries?: Array<{ iso_3166_1?: string; name?: string }>;
  created_by?: Array<{ name?: string }>;
  credits?: {
    cast?: Array<{ name?: string; order?: number }>;
    crew?: Array<{ name?: string; job?: string; department?: string }>;
  };
};

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";

const movieGenres: Record<number, string> = {
  12: "冒险", 14: "奇幻", 16: "动画", 18: "剧情", 27: "恐怖", 28: "动作", 35: "喜剧", 36: "历史", 37: "西部", 53: "惊悚", 80: "犯罪", 99: "纪录片", 878: "科幻", 9648: "悬疑", 10402: "音乐", 10749: "爱情", 10751: "家庭", 10752: "战争", 10770: "电视电影",
};

const tvGenres: Record<number, string> = {
  16: "动画", 18: "剧情", 35: "喜剧", 37: "西部", 80: "犯罪", 99: "纪录片", 10751: "家庭", 10759: "动作冒险", 10762: "儿童", 10763: "新闻", 10764: "真人秀", 10765: "科幻奇幻", 10766: "肥皂剧", 10767: "脱口秀", 10768: "战争政治", 9648: "悬疑",
};

function runtimeEnv() {
  return env as typeof env & { TMDB_API_KEY?: string };
}

function apiKey() {
  const key = runtimeEnv().TMDB_API_KEY;
  return typeof key === "string" ? key.trim().slice(0, 512) : "";
}

function imageUrl(path: string | null | undefined, size: "w500" | "w1280") {
  return path ? `${TMDB_IMAGE_BASE}${size}${path}` : "";
}

function yearFrom(date?: string) {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

function genreNames(type: TmdbMediaType, ids: number[] = []) {
  const dictionary = type === "movie" ? movieGenres : tvGenres;
  return Array.from(new Set(ids.map((id) => dictionary[id]).filter(Boolean)));
}

function titleFor(item: TmdbSearchItem) {
  return item.title || item.name || "未命名影视条目";
}

function originalTitleFor(item: TmdbSearchItem) {
  return item.original_title || item.original_name || "";
}

function dateFor(item: TmdbSearchItem) {
  return item.release_date || item.first_air_date || "";
}

function normalizeSearchItem(item: TmdbSearchItem, type: TmdbMediaType): TmdbMediaResult {
  const id = Number(item.id);
  const date = dateFor(item);
  const title = titleFor(item);
  const originalTitle = originalTitleFor(item);
  const coverImage = imageUrl(item.poster_path, "w500");
  const backdropImage = imageUrl(item.backdrop_path, "w1280");
  const genres = genreNames(type, item.genre_ids);
  return {
    id,
    title,
    originalTitle,
    year: yearFrom(date),
    coverImage,
    backdropImage,
    overview: item.overview || "",
    rating: Number(item.vote_average) || 0,
    genres,
    tmdbId: id,
    source: "tmdb",
    date,
    total: type === "movie" ? 1 : 0,
    image: coverImage,
    jp: originalTitle,
  };
}

function countryFor(detail: TmdbDetail) {
  const names = (detail.production_countries || []).map((country) => country.name || country.iso_3166_1 || "").filter(Boolean);
  if (names.length) return Array.from(new Set(names)).slice(0, 8).join(" / ");
  return Array.from(new Set((detail.origin_country || []).filter(Boolean))).slice(0, 8).join(" / ");
}

function directorFor(detail: TmdbDetail) {
  const crewDirector = detail.credits?.crew?.find((person) => person.job === "Director" || (person.department === "Directing" && person.name));
  return crewDirector?.name || detail.created_by?.map((person) => person.name || "").filter(Boolean).slice(0, 3).join(" / ") || "";
}

function actorsFor(detail: TmdbDetail) {
  return (detail.credits?.cast || []).sort((a, b) => (a.order ?? 999) - (b.order ?? 999)).map((person) => person.name || "").filter(Boolean).slice(0, 20);
}

function detailMetadata(detail: TmdbDetail, type: TmdbMediaType) {
  const date = dateFor(detail);
  const genres = (detail.genres || []).map((genre) => genre.name || "").filter(Boolean);
  const runtime = type === "movie" ? Number(detail.runtime) || undefined : Number(detail.episode_run_time?.[0]) || undefined;
  return {
    director: directorFor(detail),
    actors: actorsFor(detail),
    year: yearFrom(date),
    region: countryFor(detail),
    seasons: type === "tv" ? Number(detail.number_of_seasons) || undefined : undefined,
    episodes: type === "tv" ? Number(detail.number_of_episodes) || undefined : undefined,
    tmdbId: Number(detail.id),
    backdropImage: imageUrl(detail.backdrop_path, "w1280"),
    overview: detail.overview || "",
    originalTitle: originalTitleFor(detail),
    genres,
    runtime,
    provider: "tmdb" as const,
  };
}

function requestUrl(path: string, params: Record<string, string> = {}) {
  const key = apiKey();
  if (!key) throw new TmdbApiError("TMDB_API_KEY 未配置", 503);
  const url = new URL(`${TMDB_API_BASE}${path}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "zh-CN");
  url.searchParams.set("include_adult", "false");
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));
  return url;
}

async function readJson<T>(url: URL, options: { signal?: AbortSignal } = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "TsukiCollection/2.1" },
    signal: options.signal || AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new TmdbApiError(`TMDB 返回 ${response.status}`, response.status);
  return response.json() as Promise<T>;
}

export async function searchTmdbMedia(query: string, type: TmdbMediaType, options: { signal?: AbortSignal } = {}) {
  const endpoint = type === "movie" ? "/search/movie" : "/search/tv";
  const payload = await readJson<{ results?: TmdbSearchItem[] }>(requestUrl(endpoint, { query: query.trim().slice(0, 80), page: "1" }), options);
  return (payload.results || []).slice(0, 8).filter((item) => Number(item.id) > 0).map((item) => normalizeSearchItem(item, type));
}

export async function getTmdbMediaDetail(id: number, type: TmdbMediaType, options: { signal?: AbortSignal } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new TmdbApiError("TMDB 条目 ID 无效", 400);
  const endpoint = type === "movie" ? `/movie/${id}` : `/tv/${id}`;
  const detail = await readJson<TmdbDetail>(requestUrl(endpoint, { append_to_response: "credits" }), options);
  const normalized = normalizeSearchItem(detail, type);
  const metadata = detailMetadata(detail, type);
  return {
    ...normalized,
    coverImage: imageUrl(detail.poster_path, "w500"),
    backdropImage: metadata.backdropImage,
    overview: detail.overview || "",
    rating: Number(detail.vote_average) || 0,
    genres: metadata.genres,
    total: type === "movie" ? 1 : metadata.episodes || 0,
    director: metadata.director,
    actors: metadata.actors,
    country: metadata.region,
    runtime: metadata.runtime,
    seasons: metadata.seasons,
    episodes: metadata.episodes,
    metadata,
  };
}
