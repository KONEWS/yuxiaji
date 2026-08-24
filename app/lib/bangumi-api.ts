export const BANGUMI_API_BASE = "https://api.bgm.tv/v0";

export type BangumiRequestOptions = {
  /** Optional future Bangumi user token. It is never persisted by this module. */
  userToken?: string;
  signal?: AbortSignal;
};

export type BangumiSubjectSummary = {
  id: number;
  name: string;
  name_cn?: string;
  date?: string;
  eps?: number;
  volumes?: number;
  images?: { large?: string; common?: string; medium?: string; small?: string; grid?: string };
};

export type BangumiSubjectDetail = BangumiSubjectSummary & {
  summary?: string;
  platform?: string;
  rating?: { score?: number; total?: number; rank?: number };
  collection?: { rank?: number };
  tags?: Array<{ name?: string; count?: number }>;
};

export type BangumiCollection = {
  subject_id: number;
  subject_type?: number;
  type?: number;
  collection_type?: number;
  rate?: number;
  comment?: string;
  tag?: string[];
  tags?: string[];
  ep_status?: number;
  vol_status?: number;
  updated_at?: string;
};

export type BangumiUser = {
  id: number;
  username?: string;
  nickname?: string;
  sign?: string;
};

export type BangumiCollectionUpdate = {
  type?: 1 | 2 | 3 | 4 | 5;
  rate?: number;
  ep_status?: number;
  vol_status?: number;
  comment?: string;
  private?: boolean;
  tags?: string[];
};

type BangumiEpisodeCollection = {
  episode?: { id?: number; type?: number; ep?: number; sort?: number };
  type?: number;
};

export class BangumiApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "BangumiApiError";
  }
}

const typeIds: Record<string, number[]> = {
  anime: [2],
  game: [4],
  novel: [1],
  light_novel: [1],
  manga: [1],
  music: [3],
};

function normalizeUserToken(token?: string) {
  let value = typeof token === "string" ? token.trim() : "";
  // Accept the formats commonly copied from Bangumi's token page:
  // a raw token, `Bearer <token>`, or a JSON response containing
  // `access_token`. Only the token itself is sent to Bangumi.
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const nested = parsed.access_token ?? parsed.accessToken ?? parsed.token;
      if (typeof nested === "string") value = nested.trim();
    } catch {
      // Keep the original value so the API can return its normal 401 error.
    }
  }
  value = value.replace(/^Bearer\s+/i, "").trim();
  return value ? value.slice(0, 512) : "";
}

function requestHeaders(options: BangumiRequestOptions = {}) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "jlHKO/yuexiaji/0.1.0",
  };
  const token = normalizeUserToken(options.userToken);
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function readJson<T>(url: string, init: RequestInit, options: BangumiRequestOptions = {}) {
  const response = await fetch(url, { ...init, signal: options.signal || AbortSignal.timeout(8000) });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.clone().json() as { detail?: unknown; error?: unknown; message?: unknown };
      detail = String(body.detail ?? body.error ?? body.message ?? "").trim();
    } catch {
      // Ignore non-JSON error bodies from the upstream API.
    }
    throw new BangumiApiError(`Bangumi 返回 ${response.status}${detail ? `：${detail.slice(0, 240)}` : ""}`, response.status);
  }
  return response.json() as Promise<T>;
}

async function requestNoContent(url: string, init: RequestInit, options: BangumiRequestOptions = {}) {
  const response = await fetch(url, { ...init, signal: options.signal || AbortSignal.timeout(8000) });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.clone().json() as { detail?: unknown; error?: unknown; message?: unknown };
      detail = String(body.detail ?? body.error ?? body.message ?? "").trim();
    } catch {
      // Preserve the HTTP status for non-JSON upstream errors.
    }
    throw new BangumiApiError(`Bangumi 返回 ${response.status}${detail ? `：${detail.slice(0, 240)}` : ""}`, response.status);
  }
}

export function bangumiTypesFor(mediaType?: string) {
  return typeIds[mediaType || "anime"];
}

export async function searchBangumiSubjects(query: string, mediaType = "anime", options: BangumiRequestOptions = {}) {
  const types = bangumiTypesFor(mediaType);
  if (!types) throw new BangumiApiError("该媒体类型不使用 Bangumi 数据源", 400);
  const payload = await readJson<{ data?: BangumiSubjectSummary[] }>(`${BANGUMI_API_BASE}/search/subjects?limit=8&offset=0`, {
    method: "POST",
    headers: { ...requestHeaders(options), "content-type": "application/json" },
    body: JSON.stringify({ keyword: query, sort: "match", filter: { type: types, nsfw: false } }),
  }, options);
  return payload.data || [];
}

export async function resolveBangumiSubjectId(query: string, mediaType = "anime", options: BangumiRequestOptions = {}) {
  const results = await searchBangumiSubjects(query, mediaType, options);
  return results[0]?.id;
}

export async function getBangumiSubject(id: number, options: BangumiRequestOptions = {}) {
  return readJson<BangumiSubjectDetail>(`${BANGUMI_API_BASE}/subjects/${id}`, {
    headers: requestHeaders(options),
  }, options);
}

export async function getBangumiCurrentUser(options: BangumiRequestOptions = {}) {
  if (!normalizeUserToken(options.userToken)) throw new BangumiApiError("缺少 Bangumi Access Token", 401);
  return readJson<BangumiUser>(`${BANGUMI_API_BASE}/me`, {
    headers: requestHeaders(options),
  }, options);
}

export async function getBangumiUserCollections(username: string, options: BangumiRequestOptions = {}) {
  const name = username.trim().slice(0, 80);
  if (!name) throw new BangumiApiError("缺少 Bangumi 用户名", 400);
  // Bangumi's documented default_query_limit has a maximum of 50. Sending
  // 100 returns a validation error before any collection data is returned.
  const payload = await readJson<{ data?: BangumiCollection[] }>(`${BANGUMI_API_BASE}/users/${encodeURIComponent(name)}/collections?limit=50&offset=0`, {
    headers: requestHeaders(options),
  }, options);
  return payload.data || [];
}

/** Fetch the complete collection in bounded pages for account synchronization. */
export async function getAllBangumiUserCollections(username: string, options: BangumiRequestOptions = {}, maxItems = 1000) {
  const all: BangumiCollection[] = [];
  const pageSize = 50;
  for (let offset = 0; offset < maxItems; offset += pageSize) {
    const name = username.trim().slice(0, 80);
    if (!name) throw new BangumiApiError("缺少 Bangumi 用户名", 400);
    const payload = await readJson<{ data?: BangumiCollection[] }>(`${BANGUMI_API_BASE}/users/${encodeURIComponent(name)}/collections?limit=${pageSize}&offset=${offset}`, {
      headers: requestHeaders(options),
    }, options);
    const page = payload.data || [];
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all.slice(0, maxItems);
}

export async function updateBangumiCollection(subjectId: number, payload: BangumiCollectionUpdate, options: BangumiRequestOptions = {}) {
  await requestNoContent(`${BANGUMI_API_BASE}/users/-/collections/${subjectId}`, {
    method: "POST",
    headers: { ...requestHeaders(options), "content-type": "application/json" },
    body: JSON.stringify(payload),
  }, options);
}

export async function markBangumiAnimeProgress(subjectId: number, progress: number, options: BangumiRequestOptions = {}) {
  if (!Number.isInteger(progress) || progress <= 0) return 0;
  const payload = await readJson<{ data?: BangumiEpisodeCollection[] }>(`${BANGUMI_API_BASE}/users/-/collections/${subjectId}/episodes?limit=1000&offset=0&episode_type=0`, {
    headers: requestHeaders(options),
  }, options);
  const episodeIds = (payload.data || [])
    .filter((item) => item.episode?.type === 0 && Number(item.episode.ep ?? item.episode.sort) <= progress && item.type !== 2)
    .map((item) => Number(item.episode?.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  for (let offset = 0; offset < episodeIds.length; offset += 100) {
    await requestNoContent(`${BANGUMI_API_BASE}/users/-/collections/${subjectId}/episodes`, {
      method: "PATCH",
      headers: { ...requestHeaders(options), "content-type": "application/json" },
      body: JSON.stringify({ episode_id: episodeIds.slice(offset, offset + 100), type: 2 }),
    }, options);
  }
  return episodeIds.length;
}

export function subjectImage(subject: BangumiSubjectSummary) {
  return subject.images?.large || subject.images?.common || subject.images?.medium || subject.images?.small || subject.images?.grid || "";
}

export function subjectTitle(subject: BangumiSubjectSummary) {
  return subject.name_cn || subject.name;
}

export function subjectScore(subject: BangumiSubjectDetail) {
  return Number(subject.rating?.score) || 0;
}

export function subjectTags(subject: BangumiSubjectDetail) {
  return (subject.tags || []).sort((a, b) => (b.count || 0) - (a.count || 0)).map((tag) => tag.name || "").filter(Boolean).slice(0, 10);
}

/** Read a future user token from an explicit app header; no OAuth flow is involved. */
export function bangumiRequestOptions(request: Request): BangumiRequestOptions {
  return { userToken: request.headers.get("x-bangumi-user-token") || undefined };
}
