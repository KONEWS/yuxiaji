import type { DeviceCategoryId, DeviceCategoryLabels, DeviceSubCategoryMap, MediaMetadata, TagPreferences } from "./constants";
import type { MediaStorageLink } from "./client-api";
import type { DEVICE_STATUSES } from "./constants";

export type Status = "watching" | "wish" | "finished" | "library" | "dropped";
export type MediaType = "anime" | "movie" | "tv" | "game" | "light_novel" | "manga" | "music" | "visual" | "video";
export type VisualSubtype = string;
export type MediaTab = MediaType | "all";
export type SortMode = "updated" | "personal" | "global" | "progress" | "title";
export type Modal = "sync" | "add" | "collection" | "collection_manager" | "settings" | "connectivity" | "calendar" | "complete" | "detail" | "device" | "device_categories" | "visual_subtypes" | "video_subtypes" | "receipt" | null;
export type View = "acg" | "devices";
export type LayoutMode = "grid" | "list";
export type { TagPreferences };
export type TagEntry = { label: string; rawTags: string[]; count: number; pinned: boolean; hidden: boolean };

/**
 * A stored image belonging to a media record. Gallery records may contain
 * several thumbnail-only images; `url` and `thumbnail` are both accepted so
 * clients remain compatible with the legacy single-thumbnail response.
 */
export const MAX_GALLERY_IMAGES = 60;

export type MediaImage = {
  id?: number;
  subjectId?: number;
  url?: string;
  thumbnail?: string;
  sourceUrl?: string;
  imageHash?: string;
  sortOrder?: number;
  isCover?: boolean;
  width?: number;
  height?: number;
  mime?: string;
  createdAt?: number;
  updatedAt?: number;
};

export function mediaImageUrl(image?: MediaImage | null) {
  return image?.url || image?.thumbnail || "";
}

/** Normalize API/legacy image arrays while keeping the first cover stable. */
export function normalizeMediaImages(value: unknown, fallback = ""): MediaImage[] {
  const raw = Array.isArray(value) ? value : [];
  const images: MediaImage[] = raw.flatMap((entry, index): MediaImage[] => {
    const candidate = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const url = typeof candidate.url === "string" ? candidate.url : typeof candidate.thumbnail === "string" ? candidate.thumbnail : "";
    if (!url) return [];
    return [{
      id: Number.isSafeInteger(Number(candidate.id)) && Number(candidate.id) > 0 ? Number(candidate.id) : undefined,
      subjectId: Number.isSafeInteger(Number(candidate.subjectId)) && Number(candidate.subjectId) > 0 ? Number(candidate.subjectId) : undefined,
      url,
      thumbnail: typeof candidate.thumbnail === "string" ? candidate.thumbnail : url,
      sourceUrl: typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : undefined,
      imageHash: typeof candidate.imageHash === "string" ? candidate.imageHash : undefined,
      sortOrder: Number.isFinite(Number(candidate.sortOrder)) ? Number(candidate.sortOrder) : index,
      isCover: Boolean(candidate.isCover),
      width: Number.isFinite(Number(candidate.width)) ? Number(candidate.width) : undefined,
      height: Number.isFinite(Number(candidate.height)) ? Number(candidate.height) : undefined,
      mime: typeof candidate.mime === "string" ? candidate.mime : undefined,
      createdAt: Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : undefined,
      updatedAt: Number.isFinite(Number(candidate.updatedAt)) ? Number(candidate.updatedAt) : undefined,
    }];
  });
  const unique = images.filter((entry, index, list) => list.findIndex((candidate) => mediaImageUrl(candidate) === mediaImageUrl(entry)) === index)
    .slice(0, MAX_GALLERY_IMAGES)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  if (!unique.length && fallback) unique.push({ url: fallback, thumbnail: fallback, sortOrder: 0, isCover: true });
  const coverIndex = unique.findIndex((entry) => entry.isCover);
  unique.forEach((entry, index) => { entry.sortOrder = index; entry.isCover = coverIndex >= 0 ? index === coverIndex : index === 0; });
  return unique;
}

export type Anime = {
  id: number;
  title: string;
  jp: string;
  note: string;
  progress: number;
  total: number;
  status: Status;
  kind: "coral" | "yellow" | "girls" | "escape";
  score?: number;
  next?: string;
  image?: string;
  cover?: string;
  description?: string;
  thumbnail?: string;
  images?: MediaImage[];
  subjectId?: number;
  mediaType?: MediaType;
  unit?: string;
  globalScore?: number;
  source?: string;
  collection?: string;
  tags: string[];
  musicAlbum?: string;
  musicArtist?: string;
  lyricist?: string;
  composer?: string;
  animeSong?: boolean;
  visualSubtype?: VisualSubtype;
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
  updatedAt?: number;
};

export type Device = {
  id: number;
  name: string;
  category: DeviceCategoryId;
  subCategory: string;
  status: (typeof DEVICE_STATUSES)[number]["id"];
  price: number | null;
  currency: string;
  purchaseDate: string | null;
  receiptImage: string;
  coverImage: string;
  coverPositionX: number;
  coverPositionY: number;
  coverZoom: number;
  tags: string[];
  rating: number | null;
  review: string;
  updatedAt: number;
};

export type DeviceForm = {
  name: string;
  category: Device["category"];
  subCategory: string;
  status: Device["status"];
  price: string;
  purchaseDate: string;
  receiptImage: string;
  coverImage: string;
  coverPositionX: number;
  coverPositionY: number;
  coverZoom: number;
  tags: string;
  rating: string;
  review: string;
};

export type SearchResult = { id: number; title: string; jp: string; total: number; date: string; source: string; externalId?: string; image?: string; originalTitle?: string; year?: number; coverImage?: string; backdropImage?: string; overview?: string; rating?: number; genres?: string[]; tmdbId?: number; metadata?: MediaMetadata };
export type AddForm = { title: string; jp: string; total: number; status: Status; note: string; image: string; thumbnail: string; images?: MediaImage[]; mediaType: MediaType; collection: string; tags: string; musicAlbum: string; musicArtist: string; lyricist: string; composer: string; source: string; animeSong: boolean; visualSubtype: VisualSubtype; videoSubtype: string; sourceUrl: string; pixivPid: string; author: string; twitterSource: string; characterTags: string; metadata: MediaMetadata; globalScore?: number; subjectId?: number };
export type HealthService = { id: string; name: string; description: string; ok: boolean; latency: number; status?: "正常" | "异常" | "未配置" };
export type HealthReport = { checkedAt: string; services: HealthService[] };
export type ConnectionItem = { icon: string; name: string; description: string; status: string; latency: string; tone: "cyan" | "purple" | "gray" };
export type BangumiDetail = { id: number; externalId?: string; title: string; jp: string; summary: string; total: number; date: string; platform: string; image: string; score: number; ratingTotal: number; rank?: number; tags: string[]; metadata?: MediaMetadata; source?: string; backdropImage?: string; genres?: string[]; originalTitle?: string };
export type SyncTarget = "bangumi" | "bangumi_pull" | "bangumi_push";
export type WeekDay = "一" | "二" | "三" | "四" | "五" | "六" | "日";
export type CalendarDay = WeekDay | "all";
export type CalendarEntry = { title: string; jp: string; subjectId?: number; sourceIds?: Record<string, string>; coverQuery: string; coverUrl?: string; meta: string; followed: boolean; source: string; day: WeekDay; long: boolean };
export type AiringSchedule = {
  id: number;
  subjectId: number;
  title: string;
  jpTitle: string;
  weekday: number;
  weekdayLabel: string;
  airTime: string;
  timezone: string;
  nextEpisode: number | null;
  nextAirAt: string | null;
  season: string;
  year: number;
  source: string;
  metadata: Record<string, unknown>;
  lastChecked: string | null;
  isCollected: boolean;
  mediaId: number | null;
  mediaTitle: string | null;
};

export type DevicePreferences = {
  deviceSubCategories: DeviceSubCategoryMap;
  deviceCategoryLabels: DeviceCategoryLabels;
  deviceCategoryManagerTab: DeviceCategoryId;
};
