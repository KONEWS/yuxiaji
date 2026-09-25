import type { AiringSchedule, MediaImage } from "./tracker-types";
import type { DeviceCategoryId, DeviceStatus, MediaMetadata, SyncSettings } from "./constants";

export type TrackerStatePayload = {
  collections?: string[];
  bangumiSyncTypes?: string[];
  syncSettings?: SyncSettings;
  mediaOrder?: string[];
  deviceSubCategories?: Record<string, string[]>;
  deviceCategoryLabels?: Record<string, string>;
  visualSubtypeLabels?: Record<string, string>;
  videoSubtypeLabels?: Record<string, string>;
  avatarImage?: string;
  font: string;
  softness: number;
  backgroundVersion: number;
  primaryColor: string;
  accentColor: string;
  titleMode: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string; details?: string };
  if (!response.ok) throw new Error([payload.error, payload.details].filter(Boolean).join("：") || `请求失败：${response.status}`);
  return payload;
}

export async function loadTrackerState<T>() {
  const response = await fetch("/api/state", { headers: { accept: "application/json" }, cache: "no-store" });
  if (response.status === 401) return null;
  const payload = await readJson<{ state: T | null }>(response);
  return payload.state;
}

export async function saveTrackerState(state: TrackerStatePayload) {
  const response = await fetch("/api/state", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(state),
  });
  return readJson<{ ok: boolean }>(response);
}

export async function searchRemoteAnime<T>(query: string, mediaType = "anime") {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(mediaType)}`, { headers: { accept: "application/json" } });
  const payload = await readJson<{ results: T[] }>(response);
  return Array.isArray(payload.results) ? payload.results : [];
}

export type MediaRecordPayload = {
  id?: number;
  mediaType: "anime" | "movie" | "tv" | "game" | "light_novel" | "manga" | "music" | "visual" | "video";
  subjectId?: number | null;
  title: string;
  jp?: string;
  note?: string;
  progress: number;
  total: number;
  status: "watching" | "wish" | "finished" | "library" | "dropped";
  kind?: string;
  score?: number | null;
  next?: string | null;
  image?: string | null;
  cover?: string | null;
  description?: string;
  thumbnail?: string | null;
  /** Gallery-only images. Omit to preserve existing images; pass [] to clear. */
  images?: MediaImage[];
  globalScore?: number | null;
  source?: string;
  collection?: string;
  tags?: string[];
  musicAlbum?: string;
  musicArtist?: string;
  lyricist?: string;
  composer?: string;
  animeSong?: boolean;
  visualSubtype?: string;
  videoSubtype?: string;
  sourceUrl?: string;
  pixivPid?: string;
  author?: string;
  twitterSource?: string;
  characterTags?: string[];
  metadata?: MediaMetadata;
  platform?: string;
  creator?: string;
  duration?: string;
  storageLinks?: MediaStorageLink[];
};

export type StorageLinkState = "linked" | "verified" | "uncertain" | "failed";

export type MediaStorageLink = {
  id?: number;
  mediaId?: number;
  provider: string;
  label?: string;
  url?: string;
  path?: string;
  isPrimary?: boolean;
  state?: StorageLinkState;
  operationKey?: string;
  objectCount?: number;
  totalBytes?: number;
  manifestSha256?: string;
  verifiedAt?: number | null;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type MediaListPayload = {
  subjects: Array<MediaRecordPayload & { id: number; updatedAt?: number }>;
  stats: { count: number; active: number };
};

export async function loadMedia(params: { type?: string; status?: string; collection?: string; q?: string } = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => { if (value) query.set(key, value); });
  const response = await fetch(`/api/media?${query.toString()}`, { headers: { accept: "application/json" }, cache: "no-store" });
  return readJson<MediaListPayload>(response);
}

export async function loadAiringSchedules(params: { season?: string; year?: number; weekday?: number | string; source?: string } = {}) {
  const query = new URLSearchParams();
  if (params.season) query.set("season", params.season);
  if (params.year) query.set("year", String(params.year));
  if (params.weekday) query.set("weekday", String(params.weekday));
  if (params.source) query.set("source", params.source);
  const response = await fetch(`/api/anime/airing?${query.toString()}`, { headers: { accept: "application/json" }, cache: "no-store" });
  return readJson<{ season: string; year: number; timezone: string; schedules: AiringSchedule[] }>(response);
}

export type AiringSyncProgress = { progress: number; stage: string };
export type AiringSyncResult = {
  success?: boolean;
  ok: boolean;
  provider: string;
  season: string;
  year: number;
  requested: number;
  synced: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ subjectId: number; error: string }>;
  matched?: number;
  count?: number;
  syncedAt: string;
};

/** Sync schedules, consuming the Worker SSE progress stream when available. */
export async function syncAiringSchedules(params: { season?: string; year?: number; source?: string } = {}, onProgress?: (value: AiringSyncProgress) => void) {
  const response = await fetch("/api/anime/airing/sync", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream, application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok && !response.headers.get("content-type")?.includes("text/event-stream")) return readJson<AiringSyncResult>(response);
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) return readJson<AiringSyncResult>(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AiringSyncResult | null = null;
  let failure: string | null = null;
  const consume = (block: string) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    try {
      const payload = JSON.parse(data) as AiringSyncProgress & AiringSyncResult & { message?: string; error?: boolean };
      if (event === "progress") onProgress?.({ progress: Math.max(0, Math.min(100, Number(payload.progress) || 0)), stage: payload.stage });
      else if (event === "complete") result = payload;
      else if (event === "error") failure = payload.message || "放送计划同步失败";
    } catch {
      failure = "放送计划同步响应无效";
    }
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      consume(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
    }
    if (chunk.done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (failure) throw new Error(failure);
  if (!result) throw new Error("放送计划同步未返回结果");
  return result;
}

export type CustomAiringInput = { id?: number; subjectId?: number; title: string; jpTitle?: string; weekday: number; airTime?: string; nextEpisode?: number; nextAirAt?: string; season?: string; year?: number; description?: string };

export async function saveCustomAiring(input: CustomAiringInput) {
  const response = await fetch("/api/anime/airing/custom", { method: input.id ? "PATCH" : "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(input) });
  return readJson<{ ok: boolean; id: number; created?: boolean; updated?: boolean }>(response);
}

export async function removeCustomAiring(id: number) {
  const response = await fetch(`/api/anime/airing/custom?id=${id}`, { method: "DELETE", headers: { accept: "application/json" } });
  return readJson<{ ok: boolean; id: number }>(response);
}

export async function saveMedia(subject: MediaRecordPayload) {
  const response = await fetch("/api/media", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(subject),
  });
  return readJson<{ ok: boolean; subject: MediaRecordPayload & { id: number } }>(response);
}

export async function removeMedia(id: number) {
  const response = await fetch(`/api/media?id=${id}`, { method: "DELETE", headers: { accept: "application/json" } });
  return readJson<{ ok: boolean }>(response);
}

export async function loadMediaStorageLinks(mediaId: number) {
  const response = await fetch(`/api/media/storage?mediaId=${encodeURIComponent(String(mediaId))}`, { headers: { accept: "application/json" }, cache: "no-store" });
  return readJson<{ mediaId: number; storageLinks: MediaStorageLink[] }>(response);
}

export async function saveMediaStorageLink(mediaId: number, link: MediaStorageLink) {
  const response = await fetch("/api/media/storage", {
    method: link.id ? "PATCH" : "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ...link, mediaId }),
  });
  return readJson<{ ok: boolean; mediaId: number; storageLink: MediaStorageLink; storageLinks: MediaStorageLink[] }>(response);
}

export async function removeMediaStorageLink(mediaId: number, id: number) {
  const response = await fetch(`/api/media/storage?mediaId=${encodeURIComponent(String(mediaId))}&id=${encodeURIComponent(String(id))}`, { method: "DELETE", headers: { accept: "application/json" } });
  return readJson<{ ok: boolean; storageLinks: MediaStorageLink[] }>(response);
}

export type SubjectDetailOptions = { provider?: "bangumi" | "vndb" | "tmdb" | "anilist" | "mangadex" | "google_books" | "open_library" | "ndl"; externalId?: string };

export async function fetchSubjectDetail<T>(subjectId?: number, query?: string, mediaType = "anime", options: SubjectDetailOptions = {}) {
  const params = new URLSearchParams();
  if (subjectId) params.set("id", String(subjectId));
  else if (query) params.set("q", query);
  params.set("type", mediaType);
  if (options.provider) params.set("provider", options.provider);
  if (options.externalId) params.set(options.provider === "vndb" ? "vndbId" : "externalId", options.externalId);
  const response = await fetch(`/api/subject?${params.toString()}`, { headers: { accept: "application/json" } });
  return readJson<T>(response);
}

export type BangumiSyncResult = {
  ok: boolean;
  provider: "bangumi";
  authMode: "public" | "user_token";
  requested: number;
  synced: number;
  failed: number;
  updates: Array<{ mediaId: number; subjectId: number; jp?: string; total?: number; image?: string; globalScore?: number; updatedAt?: number }>;
  errors: Array<{ mediaId: number; subjectId: number; error: string }>;
  mode?: "refresh" | "import";
};

export async function syncBangumi(payload: { types: string[]; userToken?: string; subjectIds?: number[]; mode?: "refresh" | "import"; username?: string; syncSettings?: SyncSettings }) {
  const response = await fetch("/api/bangumi/sync", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  return readJson<BangumiSyncResult>(response);
}

export function highResCoverUrl(query: string) {
  return `/api/cover?q=${encodeURIComponent(query)}`;
}

export async function uploadCustomBackground(file: File) {
  const form = new FormData();
  form.append("background", file);
  const response = await fetch("/api/background", { method: "POST", body: form });
  return readJson<{ ok: boolean; version: number }>(response);
}

export async function uploadAvatar(file: File) {
  const form = new FormData();
  form.append("avatar", file);
  const response = await fetch("/api/avatar", { method: "POST", body: form });
  return readJson<{ ok: boolean; url: string }>(response);
}

export function customBackgroundUrl(version: number) {
  return `/api/background?v=${version}`;
}

export type DevicePayload = {
  id?: number;
  name: string;
  category: DeviceCategoryId;
  subCategory: string;
  status: DeviceStatus;
  price?: number | null;
  currency?: string;
  purchaseDate?: string | null;
  receiptImage?: string;
  coverImage?: string;
  coverPositionX?: number;
  coverPositionY?: number;
  coverZoom?: number;
  tags: string[];
  rating?: number | null;
  review?: string;
};

export type DeviceListPayload = {
  devices: Array<DevicePayload & { id: number; updatedAt?: number }>;
  stats: { count: number; active: number; totalInvestment: number };
};

export async function loadDevices(params: { category?: string; subCategory?: string; status?: string } = {}) {
  const query = new URLSearchParams();
  if (params.category) query.set("category", params.category);
  if (params.subCategory) query.set("subCategory", params.subCategory);
  if (params.status) query.set("status", params.status);
  const response = await fetch(`/api/devices?${query.toString()}`, { headers: { accept: "application/json" }, cache: "no-store" });
  return readJson<DeviceListPayload>(response);
}

export async function saveDevice(device: DevicePayload) {
  const response = await fetch("/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(device),
  });
  return readJson<{ ok: boolean; device: DevicePayload & { id: number } }>(response);
}

export async function removeDevice(id: number) {
  const response = await fetch(`/api/devices?id=${id}`, { method: "DELETE", headers: { accept: "application/json" } });
  return readJson<{ ok: boolean }>(response);
}

export async function uploadDeviceAsset(file: File, purpose: "receipt" | "cover") {
  const form = new FormData();
  form.append("image", file);
  form.append("purpose", purpose);
  const response = await fetch("/api/device-assets", { method: "POST", body: form });
  return readJson<{ ok: boolean; url: string }>(response);
}

/** Resize a user-selected image before upload; the original file is never stored. */
export async function uploadMediaImage(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 20 * 1024 * 1024) throw new Error("原始图片不能超过 20 MB");
  const bitmap = await createImageBitmap(file);
  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理图片");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  if (!blob) throw new Error("图片压缩失败");
  if (blob.size > 5 * 1024 * 1024) throw new Error("压缩后的缩略图不能超过 5 MB");
  const form = new FormData();
  form.append("image", new File([blob], "media-image.webp", { type: "image/webp" }));
  const response = await fetch("/api/media-assets", { method: "POST", body: form });
  return readJson<{ ok: boolean; url: string }>(response);
}

/** Attach or replace the images belonging to a gallery record. */
export async function saveGalleryImages(subjectId: number, images: MediaImage[]) {
  const response = await fetch("/api/gallery/images", {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ subjectId, images }),
  });
  return readJson<{ ok: boolean; images: MediaImage[] }>(response);
}

export async function removeGalleryImage(id: number) {
  const response = await fetch(`/api/gallery/images?id=${encodeURIComponent(String(id))}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  return readJson<{ ok: boolean; subjectId: number; images: MediaImage[] }>(response);
}
