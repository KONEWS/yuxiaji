/**
 * 「月下集」全局分类常量
 * 媒体 9 大分类 + 装备 4 大类与细分子类。
 */

/** 媒体分类（与 db/schema.ts user_subjects.type 一一对应） */
export const MEDIA_CATEGORIES = [
  { id: "anime", label: "动画", icon: "动" },
  { id: "movie", label: "电影", icon: "影" },
  { id: "tv", label: "电视剧", icon: "剧" },
  { id: "game", label: "游戏", icon: "游" },
  { id: "light_novel", label: "书籍", icon: "书" },
  { id: "manga", label: "漫画", icon: "漫" },
  { id: "music", label: "音乐", icon: "音" },
  { id: "visual", label: "画廊", icon: "画" },
  { id: "video", label: "视频", icon: "视" },
] as const;

export type MediaCategoryId = (typeof MEDIA_CATEGORIES)[number]["id"];

/** 影视条目的扩展元数据，按 JSON 存储以保持旧记录与迁移兼容。 */
export type MediaMetadata = {
  director: string;
  actors: string[];
  year?: number;
  region: string;
  seasons?: number;
  episodes?: number;
  tmdbId?: number;
  backdropImage?: string;
  overview?: string;
  overviewOverride?: boolean;
  originalTitle?: string;
  genres?: string[];
  runtime?: number;
  provider?: "tmdb" | "vndb";
  vndbId?: string;
  vndbUrl?: string;
  platforms?: string[];
  developers?: string[];
  videoSource?: string;
  platform?: string;
  creator?: string;
  duration?: string;
  /** SHA-256 digest of the uploaded Gallery source image. */
  imageHash?: string;
};

export const SYNC_PROVIDERS = ["bangumi", "vndb"] as const;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];
export const SYNC_FIELDS = ["cover", "title", "overview", "score"] as const;
export type SyncField = (typeof SYNC_FIELDS)[number];
export type SourceSyncSettings = Record<SyncField, boolean>;
export type SyncSettings = Record<SyncProvider, SourceSyncSettings>;

export type TagPreferences = {
  pinned: string[];
  hidden: string[];
  aliases: Record<string, string>;
};

export function defaultTagPreferences(): TagPreferences {
  return { pinned: [], hidden: [], aliases: {} };
}

export function normalizeTagPreferences(value?: unknown): TagPreferences {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const tags = (candidate: unknown) => Array.isArray(candidate)
    ? Array.from(new Set(candidate.map((item) => String(item).trim().slice(0, 80)).filter(Boolean))).slice(0, 300)
    : [];
  const aliases: Record<string, string> = {};
  if (source.aliases && typeof source.aliases === "object" && !Array.isArray(source.aliases)) {
    Object.entries(source.aliases as Record<string, unknown>).slice(0, 300).forEach(([key, label]) => {
      const raw = key.trim().slice(0, 80);
      const display = typeof label === "string" ? label.trim().slice(0, 80) : "";
      if (raw && display && raw !== display) aliases[raw] = display;
    });
  }
  return { pinned: tags(source.pinned), hidden: tags(source.hidden), aliases };
}

export function tagDisplayName(tag: string, preferences?: TagPreferences) {
  return preferences?.aliases[tag] || tag;
}

export function defaultSyncSettings(): SyncSettings {
  return {
    bangumi: { cover: true, title: false, overview: false, score: true },
    vndb: { cover: true, title: false, overview: false, score: true },
  };
}

export function normalizeSyncSettings(value?: unknown): SyncSettings {
  const defaults = defaultSyncSettings();
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalizeProvider = (provider: SyncProvider): SourceSyncSettings => {
    const candidate = source[provider] && typeof source[provider] === "object" && !Array.isArray(source[provider]) ? source[provider] as Record<string, unknown> : {};
    return {
      cover: typeof candidate.cover === "boolean" ? candidate.cover : defaults[provider].cover,
      title: typeof candidate.title === "boolean" ? candidate.title : defaults[provider].title,
      overview: typeof candidate.overview === "boolean" ? candidate.overview : defaults[provider].overview,
      score: typeof candidate.score === "boolean" ? candidate.score : defaults[provider].score,
    };
  };
  return { bangumi: normalizeProvider("bangumi"), vndb: normalizeProvider("vndb") };
}

export function normalizeMediaMetadata(value?: unknown): MediaMetadata {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const imageHash = typeof source.imageHash === "string" ? source.imageHash.trim().slice(0, 128) : "";
  const vndbId = typeof source.vndbId === "string" && /^v\d+$/i.test(source.vndbId.trim()) ? source.vndbId.trim().toLowerCase() : "";
  const actors = Array.isArray(source.actors)
    ? source.actors.map((actor) => String(actor).trim()).filter(Boolean).slice(0, 30)
    : typeof source.actors === "string"
      ? source.actors.split(/[,，、\s]+/).map((actor) => actor.trim()).filter(Boolean).slice(0, 30)
      : [];
  const numberValue = (candidate: unknown, min: number, max: number) => {
    const number = Number(candidate);
    return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
  };
  const stringArray = (candidate: unknown, max: number) => Array.isArray(candidate) ? Array.from(new Set(candidate.map((item) => String(item).trim()).filter(Boolean))).slice(0, max) : [];
  return {
    director: typeof source.director === "string" ? source.director.trim().slice(0, 160) : "",
    actors,
    year: numberValue(source.year, 1800, 3000),
    region: typeof source.region === "string" ? source.region.trim().slice(0, 80) : "",
    seasons: numberValue(source.seasons, 1, 100),
    episodes: numberValue(source.episodes, 1, 10000),
    tmdbId: numberValue(source.tmdbId, 1, 100000000),
    backdropImage: typeof source.backdropImage === "string" ? source.backdropImage.trim().slice(0, 500) : "",
    overview: typeof source.overview === "string" ? source.overview.trim().slice(0, 5000) : "",
    overviewOverride: source.overviewOverride === true,
    originalTitle: typeof source.originalTitle === "string" ? source.originalTitle.trim().slice(0, 160) : "",
    genres: stringArray(source.genres, 30),
    runtime: numberValue(source.runtime, 1, 10000),
    provider: source.provider === "tmdb" || source.provider === "vndb" ? source.provider : undefined,
    ...(vndbId ? { vndbId } : {}),
    vndbUrl: typeof source.vndbUrl === "string" ? source.vndbUrl.trim().slice(0, 300) : "",
    platforms: stringArray(source.platforms, 30),
    developers: stringArray(source.developers, 30),
    videoSource: typeof source.videoSource === "string" ? source.videoSource.trim().slice(0, 160) : "",
    platform: typeof source.platform === "string" ? source.platform.trim().slice(0, 80) : "",
    creator: typeof source.creator === "string" ? source.creator.trim().slice(0, 160) : "",
    duration: typeof source.duration === "string" ? source.duration.trim().slice(0, 40) : "",
    ...(imageHash ? { imageHash } : {}),
  };
}

/** 旧版本使用 novel 表示轻小说，读取存档时统一迁移为 light_novel */
export const MEDIA_TYPE_ALIASES: Record<string, MediaCategoryId> = {
  novel: "light_novel",
  book: "light_novel",
};

export function normalizeMediaType(value?: string | null): MediaCategoryId {
  if (value && MEDIA_CATEGORIES.some((item) => item.id === value)) return value as MediaCategoryId;
  if (value && MEDIA_TYPE_ALIASES[value]) return MEDIA_TYPE_ALIASES[value];
  return "anime";
}

export const VISUAL_SUBTYPES = [
  { id: "illustration", label: "插画" },
  { id: "wallpaper", label: "壁纸" },
  { id: "game_cg", label: "游戏 CG" },
  { id: "screenshot", label: "动画截图" },
  { id: "ai_art", label: "AI 生成图" },
  { id: "other", label: "其他" },
] as const;

export type VisualSubtypeId = string;

export function normalizeVisualSubtype(value?: string | null): VisualSubtypeId {
  const normalized = typeof value === "string" ? value.trim().slice(0, 64) : "";
  return /^[a-z0-9_-]+$/i.test(normalized) ? normalized : "other";
}

export type VisualSubtypeLabels = Record<VisualSubtypeId, string>;

export function defaultVisualSubtypeLabels(): VisualSubtypeLabels {
  return Object.fromEntries(VISUAL_SUBTYPES.map((item) => [item.id, item.label])) as VisualSubtypeLabels;
}

export function normalizeVisualSubtypeLabels(value?: Partial<Record<VisualSubtypeId, unknown>> | null): VisualSubtypeLabels {
  const defaults = defaultVisualSubtypeLabels();
  if (!value || typeof value !== "object") return defaults;
  for (const [id, candidate] of Object.entries(value)) {
    const normalizedId = normalizeVisualSubtype(id);
    if (normalizedId !== id || typeof candidate !== "string" || !candidate.trim()) continue;
    defaults[normalizedId] = candidate.trim().slice(0, 30);
  }
  return defaults;
}

export const VIDEO_SUBTYPES = [
  { id: "mad_amv", label: "MAD/AMV" },
  { id: "fan_work", label: "同人" },
  { id: "mmd", label: "MMD" },
  { id: "dance", label: "舞蹈" },
  { id: "live", label: "Live" },
  { id: "vtuber", label: "VTuber" },
  { id: "edit", label: "剪辑" },
  { id: "other", label: "其他" },
] as const;

export type VideoSubtypeId = string;
export type VideoSubtypeLabels = Record<VideoSubtypeId, string>;

export function normalizeVideoSubtype(value?: string | null): VideoSubtypeId {
  const normalized = typeof value === "string" ? value.trim().slice(0, 64) : "";
  return /^[a-z0-9_-]+$/i.test(normalized) ? normalized : "other";
}

export function defaultVideoSubtypeLabels(): VideoSubtypeLabels {
  return Object.fromEntries(VIDEO_SUBTYPES.map((item) => [item.id, item.label])) as VideoSubtypeLabels;
}

export function normalizeVideoSubtypeLabels(value?: Partial<Record<VideoSubtypeId, unknown>> | null): VideoSubtypeLabels {
  const defaults = defaultVideoSubtypeLabels();
  if (!value || typeof value !== "object") return defaults;
  const normalized: VideoSubtypeLabels = {};
  for (const [id, candidate] of Object.entries(value)) {
    const normalizedId = normalizeVideoSubtype(id);
    if (normalizedId !== id || typeof candidate !== "string" || !candidate.trim()) continue;
    normalized[normalizedId] = candidate.trim().slice(0, 30);
  }
  // An empty object is the legacy/default state; once labels are persisted,
  // preserve the user's removals instead of re-inserting deleted defaults.
  return Object.keys(normalized).length ? normalized : defaults;
}

/** 装备 4 大类（与 db/schema.ts user_devices.category 一一对应） */
export const DEVICE_CATEGORIES = [
  {
    id: "audio",
    label: "音频",
    icon: "♪",
    subCategories: ["有线耳机", "平头塞", "TWS", "头戴耳机", "解码耳放", "音箱"],
  },
  {
    id: "gaming_wearable",
    label: "游戏穿戴",
    icon: "游",
    subCategories: ["AR 眼镜", "手柄", "键鼠", "主机"],
  },
  {
    id: "pc_hardware",
    label: "电脑硬件",
    icon: "机",
    subCategories: ["整机", "硬盘", "显卡", "内存", "配件"],
  },
  {
    id: "mobile_accessories",
    label: "移动配件",
    icon: "充",
    subCategories: ["手机平板", "充电宝", "充电头", "数据线", "TF 卡"],
  },
] as const;

export type DeviceCategoryId = string;
export type DeviceCategoryDefinition = { id: DeviceCategoryId; label: string; icon: string; subCategories: string[] };
export type DeviceCategoryLabels = Record<DeviceCategoryId, string>;

export function defaultDeviceCategoryLabels(): DeviceCategoryLabels {
  return Object.fromEntries(DEVICE_CATEGORIES.map((item) => [item.id, item.label])) as DeviceCategoryLabels;
}

const DEVICE_CATEGORY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/i;

function normalizeDeviceCategoryId(value: unknown) {
  const id = typeof value === "string" ? value.trim().slice(0, 40) : "";
  return DEVICE_CATEGORY_ID_PATTERN.test(id) ? id : "";
}

export function normalizeDeviceCategoryLabels(value?: Partial<Record<DeviceCategoryId, unknown>> | null): DeviceCategoryLabels {
  const defaults = defaultDeviceCategoryLabels();
  if (!value || typeof value !== "object") return defaults;
  for (const [rawId, candidate] of Object.entries(value)) {
    const id = normalizeDeviceCategoryId(rawId);
    if (!id || typeof candidate !== "string") continue;
    defaults[id] = candidate.trim().slice(0, 30);
  }
  return defaults;
}

export type DeviceSubCategoryMap = Record<DeviceCategoryId, string[]>;

export function defaultDeviceSubCategories(): DeviceSubCategoryMap {
  return Object.fromEntries(DEVICE_CATEGORIES.map((item) => [item.id, [...item.subCategories]])) as DeviceSubCategoryMap;
}

export function normalizeDeviceSubCategories(value?: Partial<Record<DeviceCategoryId, unknown>> | null): DeviceSubCategoryMap {
  const defaults = defaultDeviceSubCategories();
  if (!value || typeof value !== "object") return defaults;
  for (const [rawId, saved] of Object.entries(value)) {
    const id = normalizeDeviceCategoryId(rawId);
    if (!id) continue;
    if (!Array.isArray(saved)) continue;
    const names = Array.from(new Set(saved.map((item) => String(item).trim()).filter(Boolean))).slice(0, 50);
    defaults[id] = names;
  }
  return defaults;
}

export function deviceCategoriesForPreferences(categoryLabels?: Partial<Record<DeviceCategoryId, unknown>> | null, subCategories?: Partial<Record<DeviceCategoryId, unknown>> | null): DeviceCategoryDefinition[] {
  const labels = normalizeDeviceCategoryLabels(categoryLabels);
  const categories = normalizeDeviceSubCategories(subCategories);
  return Object.keys(labels).filter((id) => labels[id].trim()).map((id) => {
    const base = DEVICE_CATEGORIES.find((item) => item.id === id);
    return { id, label: labels[id], icon: base?.icon || "◇", subCategories: categories[id] || [] };
  });
}

export function deviceCategory(id?: string | null) {
  return DEVICE_CATEGORIES.find((item) => item.id === id);
}

/** 设备状态：active 在役 / backup 备用 / retired 退役 */
export const DEVICE_STATUSES = [
  { id: "active", label: "在役" },
  { id: "backup", label: "备用" },
  { id: "retired", label: "退役" },
] as const;

export type DeviceStatus = (typeof DEVICE_STATUSES)[number]["id"];

export function deviceStatusLabel(status?: string | null) {
  return DEVICE_STATUSES.find((item) => item.id === status)?.label || "在役";
}
