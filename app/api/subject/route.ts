import { getMediaDetail, providerOptions, resolveMediaId, type ProviderMediaType, type ProviderLookup } from "../../lib/media-provider";
import { normalizeVndbId, vndbNumericId } from "../../lib/vndb-api";

const DETAIL_TYPES: ProviderMediaType[] = ["anime", "game", "light_novel", "manga", "music", "movie", "tv"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsedId = Number(url.searchParams.get("id"));
  const requestedId = Number.isSafeInteger(parsedId) && parsedId > 0 ? parsedId : 0;
  const query = url.searchParams.get("q")?.trim() || "";
  const requestedType = url.searchParams.get("type") || "anime";
  const normalizedType = requestedType === "book" ? "light_novel" : requestedType;
  const mediaType = DETAIL_TYPES.includes(normalizedType as ProviderMediaType) ? normalizedType as ProviderMediaType : "anime";
  const requestedProvider = url.searchParams.get("provider")?.trim().toLowerCase();
  const requestedVndbId = normalizeVndbId(url.searchParams.get("vndbId"));
  const requestedExternalId = url.searchParams.get("externalId")?.trim().slice(0, 240) || "";
  const supportedProviders = ["bangumi", "vndb", "tmdb", "anilist", "mangadex", "google_books", "open_library", "ndl"];
  const lookup: ProviderLookup = requestedProvider && supportedProviders.includes(requestedProvider)
    ? { provider: requestedProvider as ProviderLookup["provider"], externalId: requestedProvider === "bangumi" ? undefined : requestedExternalId || requestedVndbId || undefined, vndbId: requestedVndbId || undefined }
    : requestedVndbId ? { provider: "vndb", externalId: requestedVndbId } : {};
  try {
    const options = providerOptions(request);
    const hasDirectExternalId = Boolean(lookup.provider && lookup.provider !== "bangumi" && lookup.provider !== "tmdb" && lookup.externalId);
    const subjectId = lookup.provider === "vndb"
      ? vndbNumericId(requestedVndbId) || (query.length >= 2 ? await resolveMediaId(query, "game", options, lookup) : undefined)
      : lookup.provider && lookup.provider !== "bangumi" && lookup.provider !== "tmdb"
        ? requestedId || (query.length >= 2 ? await resolveMediaId(query, mediaType, options, lookup) : undefined)
      : requestedId || (query.length >= 2 ? await resolveMediaId(query, mediaType, options) : undefined);
    if (!subjectId && !hasDirectExternalId) return Response.json({ error: "未找到对应的媒体条目" }, { status: 404 });
    const subject = await getMediaDetail(subjectId || 0, mediaType, options, lookup);
    const hasUserToken = Boolean(request.headers.get("x-bangumi-user-token")?.trim() || request.headers.get("authorization")?.trim());
    return Response.json({
      id: subject.id,
      externalId: subject.externalId,
      type: mediaType,
      title: subject.title,
      jp: subject.originalTitle,
      originalTitle: subject.originalTitle,
      summary: subject.summary,
      overview: subject.overview,
      total: subject.total,
      date: subject.date,
      year: subject.year,
      platform: subject.platform,
      image: subject.coverImage,
      coverImage: subject.coverImage,
      backdropImage: subject.backdropImage,
      score: subject.rating,
      rating: subject.rating,
      ratingTotal: subject.ratingTotal,
      rank: subject.rank,
      tags: subject.tags,
      genres: subject.genres,
      director: subject.director,
      actors: subject.actors,
      country: subject.country,
      runtime: subject.runtime,
      seasons: subject.seasons,
      episodes: subject.episodes,
      tmdbId: subject.tmdbId,
      metadata: subject.metadata,
      source: subject.source,
    }, { headers: { "cache-control": hasUserToken ? "private, no-store" : "public, max-age=300, s-maxage=3600" } });
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 502;
    return Response.json({ error: error instanceof Error ? error.message : "媒体详情读取失败" }, { status: status >= 400 && status < 600 ? status : 502 });
  }
}
