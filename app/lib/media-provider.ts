import { bangumiRequestOptions, getBangumiSubject, searchBangumiSubjects, subjectImage, subjectScore, subjectTags, subjectTitle, type BangumiRequestOptions, type BangumiSubjectDetail, type BangumiSubjectSummary } from "./bangumi-api";
import { getTmdbMediaDetail, searchTmdbMedia, type TmdbMediaResult, type TmdbMediaType } from "./tmdb-api";
import { normalizeMediaMetadata, type MediaMetadata } from "./constants";
import { getVndbVisualNovel, normalizeVndbId, searchVndbVisualNovels, vndbNumericId, type VndbVisualNovel } from "./vndb-api";
import { aniListImage, aniListMetadata, aniListOriginalTitle, aniListTitle, getAniListMedia, searchAniList, type AniListMedia } from "./anilist-api";
import { getMangaDexManga, mangaDexImage, mangaDexMetadata, mangaDexOriginalTitle, mangaDexTitle, searchMangaDex, type MangaDexManga } from "./mangadex-api";
import { getGoogleBook, getNdlBook, getOpenLibraryBook, searchGoogleBooks, searchNdl, searchOpenLibrary, type BookCatalogItem, type BookProviderName } from "./books-api";

export type ProviderMediaType = "anime" | "game" | "light_novel" | "manga" | "music" | "movie" | "tv";
export type MediaProviderName = "bangumi" | "vndb" | "tmdb" | "anilist" | "mangadex" | BookProviderName;
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

function numericCompatId(value: string) {
  if (!value.trim()) return 0;
  const digits = value.match(/\d+/)?.[0];
  if (digits) return Number(digits.slice(-8)) || 1;
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) % 90000000;
  return hash || 1;
}

function aniListResult(item: AniListMedia, mediaType: "anime" | "manga"): MediaProviderResult {
  const title = aniListTitle(item);
  const originalTitle = aniListOriginalTitle(item);
  const image = aniListImage(item);
  const metadata = aniListMetadata(item);
  return { id: item.id, externalId: String(item.id), title, originalTitle, year: item.startDate?.year, coverImage: image, backdropImage: "", overview: metadata.overview || "", rating: Number(item.averageScore || 0) / 10, genres: metadata.genres || [], source: "anilist", date: item.startDate?.year ? String(item.startDate.year) : "", total: mediaType === "anime" ? item.episodes || 0 : item.chapters || item.volumes || 0, image, jp: originalTitle, metadata };
}

function mangaDexResult(item: MangaDexManga): MediaProviderResult {
  const title = mangaDexTitle(item);
  const originalTitle = mangaDexOriginalTitle(item);
  const image = mangaDexImage(item);
  const metadata = mangaDexMetadata(item);
  return { id: numericCompatId(item.id), externalId: item.id, title, originalTitle, year: item.attributes?.year, coverImage: image, backdropImage: "", overview: metadata.overview || "", rating: 0, genres: metadata.genres || [], source: "mangadex", date: item.attributes?.year ? String(item.attributes.year) : "", total: Number(item.attributes?.lastChapter) || 0, image, jp: originalTitle, metadata };
}

function bookResult(item: BookCatalogItem): MediaProviderResult {
  const metadata = { director: item.authors.join(" / "), actors: [], region: "", year: item.year, overview: item.description, originalTitle: item.originalTitle, genres: item.subjects, sources: { [item.provider]: item.id }, identifiers: { ...(item.isbn10 ? { isbn10: item.isbn10 } : {}), ...(item.isbn13 ? { isbn13: item.isbn13 } : {}) } };
  return { id: numericCompatId(item.id), externalId: item.id, title: item.title, originalTitle: item.originalTitle, year: item.year, coverImage: item.image, backdropImage: "", overview: item.description, rating: 0, genres: item.subjects, source: item.provider, date: item.year ? String(item.year) : "", total: 0, image: item.image, jp: item.originalTitle, metadata: normalizeMediaMetadata(metadata) };
}

/** Keep every provider visible in the first page instead of letting the
 * first provider consume the UI result limit. IDs are only deduplicated
 * within a provider because the same work from another catalog is still a
 * valid source choice. */
function interleaveResults(groups: MediaProviderResult[][]) {
  const output: MediaProviderResult[] = [];
  const seen = new Set<string>();
  const size = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < size; index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (!item) continue;
      const key = `${item.source}:${item.externalId || item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(item);
    }
  }
  return output;
}

function detailFromResult(result: MediaProviderResult, summary = result.overview): MediaProviderDetail {
  return { ...result, summary, platform: "", ratingTotal: 0, tags: result.genres };
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
    sources: { vndb: externalId },
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
  return interleaveResults([bangumi, vndb]);
}

export async function searchMedia(query: string, type: ProviderMediaType, options: BangumiRequestOptions = {}) {
  if (type === "movie" || type === "tv") return searchTmdbMedia(query, type, options);
  if (type === "game") return searchGameMedia(query, options);
  if (type === "manga") {
    const attempts = await Promise.allSettled([searchBangumiSubjects(query, type, options), searchAniList(query, "MANGA", options), searchMangaDex(query, options)]);
    const results = interleaveResults([
      attempts[0].status === "fulfilled" ? attempts[0].value.map(bangumiResult) : [],
      attempts[1].status === "fulfilled" ? attempts[1].value.map((item) => aniListResult(item, "manga")) : [],
      attempts[2].status === "fulfilled" ? attempts[2].value.map(mangaDexResult) : [],
    ]);
    if (!results.length) throw (attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")?.reason || new Error("漫画来源均不可用"));
    return results;
  }
  if (type === "light_novel") {
    const attempts = await Promise.allSettled([searchBangumiSubjects(query, type, options), searchAniList(query, "MANGA", options), searchNdl(query, options), searchGoogleBooks(query, options), searchOpenLibrary(query, options)]);
    const results = interleaveResults([
      attempts[0].status === "fulfilled" ? attempts[0].value.map(bangumiResult) : [],
      attempts[1].status === "fulfilled" ? attempts[1].value.map((item) => aniListResult(item, "manga")) : [],
      attempts[2].status === "fulfilled" ? attempts[2].value.map(bookResult) : [],
      attempts[3].status === "fulfilled" ? attempts[3].value.map(bookResult) : [],
      attempts[4].status === "fulfilled" ? attempts[4].value.map(bookResult) : [],
    ]);
    if (!results.length) throw (attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")?.reason || new Error("书籍来源均不可用"));
    return results;
  }
  const subjects = await searchBangumiSubjects(query, type, options);
  return subjects.map(bangumiResult);
}

export async function getMediaDetail(id: number, type: ProviderMediaType, options: BangumiRequestOptions = {}, lookup: ProviderLookup = {}) {
  if (lookup.provider === "anilist") {
    const item = await getAniListMedia(lookup.externalId || id, options);
    return detailFromResult(aniListResult(item, type === "anime" ? "anime" : "manga"), (item.description || "").replace(/<[^>]+>/g, "").trim());
  }
  if (lookup.provider === "mangadex") {
    const item = await getMangaDexManga(lookup.externalId || "", options);
    return detailFromResult(mangaDexResult(item));
  }
  if (lookup.provider === "google_books") return detailFromResult(bookResult(await getGoogleBook(lookup.externalId || String(id), options)));
  if (lookup.provider === "open_library") return detailFromResult(bookResult(await getOpenLibraryBook(lookup.externalId || String(id), options)));
  if (lookup.provider === "ndl") return detailFromResult(bookResult(await getNdlBook(lookup.externalId || String(id), options)));
  if (lookup.provider === "vndb" || lookup.vndbId) {
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
    if (result?.externalId) lookup.externalId = result.externalId;
    return result?.id;
  }
  if (lookup.provider === "anilist") {
    const result = (await searchAniList(query, type === "anime" ? "ANIME" : "MANGA", options))[0];
    if (!result) return undefined;
    lookup.externalId = String(result.id);
    return result.id;
  }
  if (lookup.provider === "mangadex") {
    const result = (await searchMangaDex(query, options))[0];
    if (!result) return undefined;
    lookup.externalId = result.id;
    return numericCompatId(result.id) || undefined;
  }
  if (lookup.provider === "google_books") {
    const result = (await searchGoogleBooks(query, options))[0];
    if (!result) return undefined;
    lookup.externalId = result.id;
    return numericCompatId(result.id) || undefined;
  }
  if (lookup.provider === "open_library") {
    const result = (await searchOpenLibrary(query, options))[0];
    if (!result) return undefined;
    lookup.externalId = result.id;
    return numericCompatId(result.id) || undefined;
  }
  if (lookup.provider === "ndl") {
    const result = (await searchNdl(query, options))[0];
    if (!result) return undefined;
    lookup.externalId = result.id;
    return numericCompatId(result.id) || undefined;
  }
  const results = await searchMedia(query, type, options);
  return results[0]?.id;
}
