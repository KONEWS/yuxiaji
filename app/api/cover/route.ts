type AniListPayload = {
  data?: { Media?: { coverImage?: { extraLarge?: string; large?: string } } };
};

type BangumiPayload = {
  data?: Array<{ images?: { large?: string; common?: string; medium?: string } }>;
};

async function aniListCover(query: string) {
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "TsukiAnimeTracker/1.1" },
    body: JSON.stringify({
      query: "query ($search: String) { Media(search: $search, type: ANIME) { coverImage { extraLarge large } } }",
      variables: { search: query },
    }),
  });
  if (!response.ok) return null;
  const payload = await response.json() as AniListPayload;
  return payload.data?.Media?.coverImage?.extraLarge || payload.data?.Media?.coverImage?.large || null;
}

async function bangumiCover(query: string) {
  const response = await fetch("https://api.bgm.tv/v0/search/subjects?limit=1&offset=0", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "TsukiAnimeTracker/1.1" },
    body: JSON.stringify({ keyword: query, sort: "match", filter: { type: [2], nsfw: false } }),
  });
  if (!response.ok) return null;
  const payload = await response.json() as BangumiPayload;
  const images = payload.data?.[0]?.images;
  return images?.large || images?.common || images?.medium || null;
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() || "";
  if (query.length < 2 || query.length > 100) return new Response("Invalid query", { status: 400 });

  try {
    const source = await aniListCover(query).catch(() => null) || await bangumiCover(query).catch(() => null);
    if (!source) return new Response("Cover not found", { status: 404 });
    const image = await fetch(source, { headers: { "user-agent": "TsukiAnimeTracker/1.1" } });
    if (!image.ok || !image.body) return new Response("Cover unavailable", { status: 502 });
    return new Response(image.body, {
      headers: {
        "content-type": image.headers.get("content-type") || "image/jpeg",
        "cache-control": "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400",
      },
    });
  } catch {
    return new Response("Cover unavailable", { status: 502 });
  }
}
