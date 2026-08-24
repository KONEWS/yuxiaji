export const VNDB_API_BASE = "https://api.vndb.org/kana";

export type VndbRequestOptions = {
  signal?: AbortSignal;
};

export type VndbVisualNovel = {
  id: string;
  title?: string | null;
  alttitle?: string | null;
  description?: string | null;
  image?: { url?: string | null } | null;
  released?: string | null;
  average?: number | null;
  rating?: number | null;
  votecount?: number | null;
  length?: number | null;
  length_minutes?: number | null;
  platforms?: string[] | null;
  developers?: Array<{ id?: string; name?: string }> | null;
  tags?: Array<{ id?: string; name?: string }> | null;
};

export class VndbApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "VndbApiError";
  }
}

const VN_FIELDS = [
  "id",
  "title",
  "alttitle",
  "description",
  "image.url",
  "released",
  "average",
  "rating",
  "votecount",
  "length",
  "length_minutes",
  "platforms",
  "developers.name",
  "tags.name",
].join(",");

export function normalizeVndbId(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  const match = raw.match(/^(?:https?:\/\/)?(?:www\.)?vndb\.org\/(v\d+)$/i) || raw.match(/^(v\d+)$/i);
  if (match) return match[1].toLowerCase();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? `v${raw}` : "";
}

export function vndbNumericId(value: unknown) {
  const normalized = normalizeVndbId(value);
  const number = Number(normalized.slice(1));
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function requestSignal(options: VndbRequestOptions) {
  return options.signal || AbortSignal.timeout(8000);
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  let detail = "";
  try {
    const body = await response.clone().json() as { message?: unknown; error?: unknown; details?: unknown };
    detail = String(body.message ?? body.error ?? body.details ?? "").trim();
  } catch {
    // Keep the HTTP status when VNDB returns a non-JSON error body.
  }
  throw new VndbApiError(`VNDB 返回 ${response.status}${detail ? `：${detail.slice(0, 240)}` : ""}`, response.status);
}

async function queryVndb(filters: unknown[], results: number, options: VndbRequestOptions = {}) {
  const response = await fetch(`${VNDB_API_BASE}/vn`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "TsukiCollection/2.1",
    },
    body: JSON.stringify({ filters, fields: VN_FIELDS, results: Math.max(1, Math.min(25, results)) }),
    signal: requestSignal(options),
  });
  const payload = await readJson<{ results?: VndbVisualNovel[] }>(response);
  return Array.isArray(payload.results) ? payload.results : [];
}

export async function searchVndbVisualNovels(query: string, options: VndbRequestOptions = {}) {
  const value = query.trim().slice(0, 80);
  if (!value) return [];
  return queryVndb(["search", "=", value], 8, options);
}

export async function getVndbVisualNovel(id: string, options: VndbRequestOptions = {}) {
  const normalized = normalizeVndbId(id);
  if (!normalized) throw new VndbApiError("VNDB 条目 ID 无效", 400);
  const [subject] = await queryVndb(["id", "=", normalized], 1, options);
  if (!subject) throw new VndbApiError(`VNDB 条目 ${normalized} 不存在`, 404);
  return subject;
}
