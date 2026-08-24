import { providerOptions, searchMedia, type ProviderMediaType } from "../../lib/media-provider";

const SEARCH_TYPES: ProviderMediaType[] = ["anime", "game", "light_novel", "manga", "music", "movie", "tv"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || "";
  const requestedType = url.searchParams.get("type") || "anime";
  const normalizedType = requestedType === "book" ? "light_novel" : requestedType;
  const mediaType = SEARCH_TYPES.includes(normalizedType as ProviderMediaType) ? normalizedType as ProviderMediaType : "anime";
  if (query.length < 2 || query.length > 80) return Response.json({ results: [] });
  try {
    const results = await searchMedia(query, mediaType, providerOptions(request));
    return Response.json({ results: results.map((item) => ({
      id: item.id,
      externalId: "externalId" in item ? item.externalId : undefined,
      title: item.title,
      jp: item.originalTitle,
      originalTitle: item.originalTitle,
      total: item.total,
      date: item.date,
      year: item.year,
      image: item.coverImage || null,
      coverImage: item.coverImage || null,
      backdropImage: item.backdropImage || null,
      overview: item.overview,
      rating: item.rating,
      genres: item.genres,
      tmdbId: item.tmdbId,
      metadata: item.metadata,
      source: item.source,
    })) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "搜索失败";
    const errorStatus = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 502;
    return Response.json({ error: message, results: [] }, { status: errorStatus >= 400 && errorStatus < 600 ? errorStatus : 502 });
  }
}
