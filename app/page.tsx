"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { customBackgroundUrl, fetchSubjectDetail, highResCoverUrl, loadAiringSchedules, loadDevices, loadMedia, loadTrackerState, removeDevice, removeMedia, saveDevice, saveMedia, saveTrackerState, searchRemoteAnime, uploadAvatar, uploadCustomBackground, uploadMediaImage, type MediaRecordPayload } from "./lib/client-api";
import { defaultDeviceCategoryLabels, defaultDeviceSubCategories, defaultSyncSettings, defaultTagPreferences, defaultVideoSubtypeLabels, defaultVisualSubtypeLabels, deviceCategoriesForPreferences, normalizeDeviceCategoryLabels, normalizeDeviceSubCategories, normalizeMediaMetadata, normalizeMediaType, normalizeSyncSettings, normalizeTagPreferences, normalizeVideoSubtype, normalizeVideoSubtypeLabels, normalizeVisualSubtype, normalizeVisualSubtypeLabels, tagDisplayName, type DeviceCategoryId, type DeviceCategoryLabels, type DeviceSubCategoryMap, type SyncField, type SyncProvider, type SyncSettings, type TagPreferences, type VideoSubtypeLabels, type VisualSubtypeLabels } from "./lib/constants";
import { CollectionSummary } from "./components/tracker/collection-summary";
import { DeviceLibrary, normalizeDevice as normalizeLibraryDevice } from "./components/tracker/device-library";
import { DeviceModal, DeviceSubCategoryModal, ReceiptModal } from "./components/tracker/device-modals";
import { MediaLibrary } from "./components/tracker/media-library";
import { AddModal, CalendarModal, CollectionManagerModal, CollectionModal, CompletionModal, DetailDrawer, VideoSubtypeModal, VisualSubtypeModal } from "./components/tracker/media-modals";
import { ConnectivityModal, SettingsModal, SyncMenu, SyncModal } from "./components/tracker/integration-modals";
import { archivedCounts, defaultCollections, defaultMediaOrder, formatBeijingTime, mediaSettings, normalizeMediaOrder, sanitizeCollectionName, scoreLabels, seedAnime, seedDevices, splitTags } from "./lib/tracker-data";
import { refreshBangumiRecords } from "./lib/agent-hikari";
import { normalizeMediaSource } from "./lib/media-source";
import type { AddForm, AiringSchedule, Anime, CalendarDay, CalendarEntry, Device, DeviceForm, LayoutMode, MediaTab, MediaType, Modal, SearchResult, SortMode, Status, SyncTarget, View } from "./lib/tracker-types";

const MEDIA_CACHE_KEY = "yuexiaji:media-cache:v1";
const DEVICE_CACHE_KEY = "yuexiaji:device-cache:v1";
const STATE_CACHE_KEY = "yuexiaji:state-cache:v1";
const TAG_PREFERENCES_KEY = "yuexiaji:tag-preferences:v1";

type CachedTrackerState = {
  collections?: string[];
  bangumiSyncTypes?: MediaType[];
  syncSettings?: SyncSettings;
  mediaOrder?: unknown[];
  deviceSubCategories?: Partial<Record<DeviceCategoryId, string[]>>;
  deviceCategoryLabels?: Partial<Record<DeviceCategoryId, string>>;
  visualSubtypeLabels?: Partial<Record<keyof VisualSubtypeLabels, string>>;
  videoSubtypeLabels?: Partial<Record<keyof VideoSubtypeLabels, string>>;
  avatarImage?: string;
  font?: string;
  softness?: number;
  backgroundVersion?: number;
  primaryColor?: string;
  accentColor?: string;
  titleMode?: string;
};

function readClientCache<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function writeClientCache(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is an optional fast cache */ }
}

function parseBangumiSubjectId(value: string) {
  const input = value.trim();
  const match = input.match(/^(?:bangumi|bgm)\s*[:#]?\s*(\d+)$/i) || input.match(/(?:bgm|bangumi)\.tv\/subject\/(\d+)/i) || input.match(/^(\d+)$/);
  const id = match ? Number(match[1]) : NaN;
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function parseVndbId(value: string) {
  const input = value.trim();
  const match = input.match(/^(?:vndb\s*[:#]?\s*)?(v\d+)$/i) || input.match(/(?:vndb\.org\/)(v\d+)/i);
  return match ? match[1].toLowerCase() : undefined;
}

function detailToSearchResult(detail: SearchResult & { summary?: string; overview?: string; rating?: number; score?: number; coverImage?: string; image?: string; originalTitle?: string; metadata?: ReturnType<typeof normalizeMediaMetadata> }) {
  return {
    id: detail.id,
    title: detail.title,
    jp: detail.originalTitle || detail.jp || "",
    originalTitle: detail.originalTitle || detail.jp || "",
    total: detail.total || 0,
    date: detail.date || "",
    year: detail.year,
    source: detail.source || "bangumi",
    externalId: detail.externalId,
    image: detail.coverImage || detail.image || "",
    coverImage: detail.coverImage || detail.image || "",
    overview: detail.overview || detail.summary || "",
    rating: detail.rating || detail.score || 0,
    genres: detail.genres || [],
    metadata: detail.metadata,
  } satisfies SearchResult;
}

function normalizeLoadedAnime(item: Partial<Anime> & Record<string, unknown>, index = 0): Anime {
  const mediaType = normalizeMediaType(typeof item.mediaType === "string" ? item.mediaType : typeof item.type === "string" ? item.type : "anime");
  const kind = item.kind === "coral" || item.kind === "yellow" || item.kind === "girls" || item.kind === "escape" ? item.kind : "coral";
  return {
    id: Number(item.id) || Date.now() + index,
    title: typeof item.title === "string" && item.title.trim() ? item.title : "未命名番剧",
    jp: typeof item.jp === "string" ? item.jp : "",
    note: typeof item.note === "string" ? item.note : typeof item.description === "string" ? item.description : "",
    progress: ["music", "visual", "movie", "video"].includes(mediaType) ? 0 : Number(item.progress) || 0,
    total: ["music", "visual", "movie", "video"].includes(mediaType) ? 1 : Number(item.total) || 12,
    status: item.status === "wish" || item.status === "finished" || item.status === "library" || item.status === "dropped" ? item.status : "watching",
    kind,
    score: typeof item.score === "number" ? item.score : undefined,
    next: typeof item.next === "string" ? item.next : undefined,
    image: mediaType === "visual" ? undefined : typeof (item.image ?? item.cover) === "string" ? String(item.image ?? item.cover) : undefined,
    cover: typeof item.cover === "string" ? item.cover : undefined,
    thumbnail: typeof item.thumbnail === "string" ? item.thumbnail : ["visual", "video"].includes(mediaType) && typeof item.image === "string" ? item.image : undefined,
    subjectId: ["visual", "movie", "tv", "video"].includes(mediaType) ? undefined : Number(item.subjectId) || undefined,
    mediaType,
    unit: typeof item.unit === "string" ? item.unit : mediaSettings[mediaType].unit,
    globalScore: typeof item.globalScore === "number" ? item.globalScore : undefined,
    source: ["visual", "movie", "tv", "video"].includes(mediaType) ? (mediaType === "visual" && item.source === "local" ? "local" : "manual") : normalizeMediaSource(typeof item.source === "string" ? item.source : undefined, item.subjectId ? "bangumi" : "manual"),
    collection: sanitizeCollectionName(typeof item.collection === "string" ? item.collection : ""),
    tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : splitTags(typeof item.tags === "string" ? item.tags : ""),
    musicAlbum: typeof item.musicAlbum === "string" ? item.musicAlbum : "",
    musicArtist: typeof item.musicArtist === "string" ? item.musicArtist : "",
    lyricist: typeof item.lyricist === "string" ? item.lyricist : "",
    composer: typeof item.composer === "string" ? item.composer : "",
    animeSong: Boolean(item.animeSong),
    visualSubtype: normalizeVisualSubtype(item.visualSubtype),
    videoSubtype: normalizeVideoSubtype(item.videoSubtype),
    sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : "",
    pixivPid: typeof item.pixivPid === "string" ? item.pixivPid : "",
    author: typeof item.author === "string" ? item.author : "",
    twitterSource: typeof item.twitterSource === "string" ? item.twitterSource : "",
    characterTags: Array.isArray(item.characterTags) ? item.characterTags.map(String).filter(Boolean) : [],
    metadata: normalizeMediaMetadata(item.metadata),
    platform: typeof item.platform === "string" ? item.platform : undefined,
    creator: typeof item.creator === "string" ? item.creator : undefined,
    duration: typeof item.duration === "string" ? item.duration : undefined,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
  };
}

function mediaPayload(item: Anime, id?: number): MediaRecordPayload {
  return {
    ...(id ? { id } : {}),
    mediaType: item.mediaType || "anime",
    subjectId: item.subjectId,
    title: item.title,
    jp: item.jp,
    note: item.note,
    progress: item.progress,
    total: item.total,
    status: item.status,
    kind: item.kind,
    score: item.score,
    next: item.next,
    image: item.image,
    cover: item.cover,
    thumbnail: item.thumbnail,
    globalScore: item.globalScore,
    source: item.source,
    collection: item.collection,
    tags: item.tags,
    musicAlbum: item.musicAlbum,
    musicArtist: item.musicArtist,
    lyricist: item.lyricist,
    composer: item.composer,
    animeSong: item.animeSong,
    visualSubtype: item.visualSubtype,
    videoSubtype: item.videoSubtype,
    sourceUrl: item.sourceUrl,
    pixivPid: item.pixivPid,
    author: item.author,
    twitterSource: item.twitterSource,
    characterTags: item.characterTags,
    metadata: item.metadata,
    platform: item.platform,
    creator: item.creator,
    duration: item.duration,
  };
}




export default function Home() {
  const [anime, setAnime] = useState<Anime[]>(seedAnime);
  const [modal, setModal] = useState<Modal>(null);
  const [closingModal, setClosingModal] = useState<NonNullable<Modal> | null>(null);
  const [calendarDay, setCalendarDay] = useState<CalendarDay>("五");
  const [activeStatus, setActiveStatus] = useState<Status | "all">("watching");
  const [activeMedia, setActiveMedia] = useState<MediaType | "all">("all");
  const [mediaOrder, setMediaOrder] = useState<MediaTab[]>(defaultMediaOrder);
  const [sortMode, setSortMode] = useState<SortMode>("updated");
  const [scoreFloor, setScoreFloor] = useState(0);
  const [ratingScope, setRatingScope] = useState<"all" | "personal" | "global">("personal");
  const [collections, setCollections] = useState(defaultCollections);
  const [activeCollection, setActiveCollection] = useState("all");
  const [activeTag, setActiveTag] = useState("all");
  const [musicAlbum, setMusicAlbum] = useState("all");
  const [musicArtist, setMusicArtist] = useState("all");
  const [musicLyricist, setMusicLyricist] = useState("all");
  const [animeSongsOnly, setAnimeSongsOnly] = useState(false);
  const [visualSubtype, setVisualSubtype] = useState("all");
  const [visualSubtypeLabels, setVisualSubtypeLabels] = useState<VisualSubtypeLabels>(() => defaultVisualSubtypeLabels());
  const [videoSubtype, setVideoSubtype] = useState("all");
  const [videoSubtypeLabels, setVideoSubtypeLabels] = useState<VideoSubtypeLabels>(() => defaultVideoSubtypeLabels());
  const [thumbnailUploading, setThumbnailUploading] = useState(false);
  const [visualSubtypeReturn, setVisualSubtypeReturn] = useState<"add" | "library" | null>(null);
  const [videoSubtypeReturn, setVideoSubtypeReturn] = useState<"add" | "library" | null>(null);
  const [collectionName, setCollectionName] = useState("");
  const [hideDropped, setHideDropped] = useState(false);
  const [completionId, setCompletionId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [listQuery, setListQuery] = useState("");
  const [query, setQuery] = useState("");
  const [searchVersion, setSearchVersion] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [font, setFont] = useState("modern");
  const [primaryColor, setPrimaryColor] = useState("#66CCFF");
  const [accentColor, setAccentColor] = useState("#8B8CD8");
  const [softness, setSoftness] = useState(72);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [titleMode, setTitleMode] = useState("cn");
  const [backgroundVersion, setBackgroundVersion] = useState(0);
  const [beijingTime, setBeijingTime] = useState("北京时间");
  const [stateLoaded, setStateLoaded] = useState(false);
  const [toast, setToast] = useState("");
  const [tagPreferences, setTagPreferences] = useState<TagPreferences>(() => normalizeTagPreferences(readClientCache<unknown>(TAG_PREFERENCES_KEY) || defaultTagPreferences()));
  const [bangumiSyncTypes, setBangumiSyncTypes] = useState<MediaType[]>(["anime", "game", "light_novel", "manga", "music"]);
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(() => defaultSyncSettings());
  const [syncing, setSyncing] = useState<SyncTarget | null>(null);
  const [syncDialogTarget, setSyncDialogTarget] = useState<SyncTarget | null>(null);
  const [airingSchedules, setAiringSchedules] = useState<AiringSchedule[]>([]);
  const [addForm, setAddForm] = useState<AddForm>({ title: "", jp: "", total: 12, status: "watching", note: "", image: "", thumbnail: "", mediaType: "anime", collection: "", tags: "", musicAlbum: "", musicArtist: "", lyricist: "", composer: "", source: "", animeSong: false, visualSubtype: "other", videoSubtype: "other", sourceUrl: "", pixivPid: "", author: "", twitterSource: "", characterTags: "", metadata: normalizeMediaMetadata() });
  const coverBackfillStarted = useRef(false);
  const [activeView, setActiveView] = useState<View>("acg");
  const [devices, setDevices] = useState<Device[]>(seedDevices);
  const [devicesPersistable, setDevicesPersistable] = useState(true);
  const [deviceCategoryTab, setDeviceCategoryTab] = useState<Device["category"] | "all">("all");
  const [deviceSubCategory, setDeviceSubCategory] = useState("all");
  const [deviceSubCategories, setDeviceSubCategories] = useState<DeviceSubCategoryMap>(() => defaultDeviceSubCategories());
  const [deviceCategoryLabels, setDeviceCategoryLabels] = useState<DeviceCategoryLabels>(() => defaultDeviceCategoryLabels());
  const [deviceCategoryManagerTab, setDeviceCategoryManagerTab] = useState<DeviceCategoryId>("audio");
  const [deviceStatusTab, setDeviceStatusTab] = useState<Device["status"] | "all">("all");
  const [deviceDraft, setDeviceDraft] = useState<Device | null>(null);
  const [deviceForm, setDeviceForm] = useState<DeviceForm | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<Device | null>(null);
  const [acgLayout, setAcgLayout] = useState<LayoutMode>("grid");
  const [deviceLayout, setDeviceLayout] = useState<LayoutMode>("grid");
  const mediaDragIndex = useRef<number | null>(null);
  const persistedMediaIds = useRef<Set<number>>(new Set());
  const layoutPreferencesLoaded = useRef(false);
  const avatarPreferenceLoaded = useRef(false);
  const deviceCategories = useMemo(() => deviceCategoriesForPreferences(deviceCategoryLabels, deviceSubCategories), [deviceCategoryLabels, deviceSubCategories]);

  useEffect(() => {
    const updateClock = () => setBeijingTime(formatBeijingTime());
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    loadAiringSchedules().then((payload) => { if (active) setAiringSchedules(Array.isArray(payload.schedules) ? payload.schedules : []); }).catch(() => { if (active) setAiringSchedules([]); });
    return () => { active = false; };
  }, []);

  const refreshAiringSchedules = async () => {
    const payload = await loadAiringSchedules();
    setAiringSchedules(Array.isArray(payload.schedules) ? payload.schedules : []);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const savedAcgLayout = window.localStorage.getItem("yuexiaji:acg-layout");
        const savedDeviceLayout = window.localStorage.getItem("yuexiaji:device-layout");
        if (savedAcgLayout === "grid" || savedAcgLayout === "list") setAcgLayout(savedAcgLayout);
        if (savedDeviceLayout === "grid" || savedDeviceLayout === "list") setDeviceLayout(savedDeviceLayout);
      } catch {
        // Local storage can be unavailable in privacy-restricted browsers.
      } finally {
        layoutPreferencesLoaded.current = true;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!layoutPreferencesLoaded.current) return;
    try { window.localStorage.setItem("yuexiaji:acg-layout", acgLayout); } catch { /* ignore storage errors */ }
  }, [acgLayout]);

  useEffect(() => {
    if (!layoutPreferencesLoaded.current) return;
    try { window.localStorage.setItem("yuexiaji:device-layout", deviceLayout); } catch { /* ignore storage errors */ }
  }, [deviceLayout]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const savedAvatar = window.localStorage.getItem("yuexiaji:avatar");
        if (savedAvatar && (savedAvatar.startsWith("data:image/") || savedAvatar.startsWith("/api/avatar"))) setAvatarUrl(savedAvatar);
      } catch {
        // Local storage can be unavailable in privacy-restricted browsers.
      } finally {
        avatarPreferenceLoaded.current = true;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!avatarPreferenceLoaded.current) return;
    try {
      if (avatarUrl) window.localStorage.setItem("yuexiaji:avatar", avatarUrl);
      else window.localStorage.removeItem("yuexiaji:avatar");
    } catch {
      window.setTimeout(() => setToast("头像保存失败，图片可能过大"), 0);
    }
  }, [avatarUrl]);

  useEffect(() => {
    let active = true;
    const applyState = (saved: CachedTrackerState) => {
      if (Array.isArray(saved.collections)) setCollections(Array.from(new Set(saved.collections.map(sanitizeCollectionName).filter(Boolean))));
      if (Array.isArray(saved.bangumiSyncTypes)) setBangumiSyncTypes(Array.from(new Set([...saved.bangumiSyncTypes.map((type) => normalizeMediaType(type)).filter((type) => ["anime", "game", "light_novel", "manga", "music"].includes(type)), "music"])) as MediaType[]);
      if (saved.syncSettings) setSyncSettings(normalizeSyncSettings(saved.syncSettings));
      if (Array.isArray(saved.mediaOrder)) setMediaOrder(normalizeMediaOrder(saved.mediaOrder));
      if (saved.deviceSubCategories) setDeviceSubCategories(normalizeDeviceSubCategories(saved.deviceSubCategories));
      if (saved.deviceCategoryLabels) setDeviceCategoryLabels(normalizeDeviceCategoryLabels(saved.deviceCategoryLabels));
      if (saved.visualSubtypeLabels) setVisualSubtypeLabels(normalizeVisualSubtypeLabels(saved.visualSubtypeLabels));
      if (saved.videoSubtypeLabels) setVideoSubtypeLabels(normalizeVideoSubtypeLabels(saved.videoSubtypeLabels));
      if (typeof saved.avatarImage === "string" && (saved.avatarImage.startsWith("/api/avatar") || saved.avatarImage.startsWith("data:image/"))) setAvatarUrl(saved.avatarImage);
      if (["modern", "round", "serif"].includes(saved.font || "")) setFont(saved.font!);
      if (typeof saved.softness === "number" && Number.isFinite(saved.softness)) setSoftness(Math.min(94, Math.max(35, saved.softness)));
      if (typeof saved.backgroundVersion === "number" && Number.isFinite(saved.backgroundVersion)) setBackgroundVersion(Math.max(0, saved.backgroundVersion));
      if (typeof saved.primaryColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.primaryColor)) setPrimaryColor(saved.primaryColor.toUpperCase());
      if (typeof saved.accentColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.accentColor)) setAccentColor(saved.accentColor.toUpperCase());
      if (saved.titleMode === "cn" || saved.titleMode === "jp") setTitleMode(saved.titleMode);
    };

    const cachedMedia = readClientCache<unknown[]>(MEDIA_CACHE_KEY);
    if (Array.isArray(cachedMedia)) {
      try {
        const cached = cachedMedia.map((item, index) => normalizeLoadedAnime(item as Partial<Anime> & Record<string, unknown>, index));
        persistedMediaIds.current = new Set(cached.map((item) => item.id));
        // Client cache is applied synchronously so the subsequent server response
        // remains authoritative instead of being overwritten by stale cache data.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setAnime(cached);
      } catch { /* discard malformed cache when the server response arrives */ }
    }
    const cachedDevices = readClientCache<unknown[]>(DEVICE_CACHE_KEY);
    if (Array.isArray(cachedDevices)) {
      try {
        const cached = cachedDevices.map((item) => normalizeLibraryDevice(item as Partial<Device> & { id: number }));
        setDevices(cached);
      } catch { /* discard malformed cache when the server response arrives */ }
    }
    const cachedState = readClientCache<CachedTrackerState>(STATE_CACHE_KEY);
    if (cachedState) {
      applyState(cachedState);
    }

    const stateRequest = loadTrackerState<CachedTrackerState>();
    const mediaRequest = loadMedia();
    const devicesRequest = loadDevices();
    Promise.allSettled([stateRequest, mediaRequest, devicesRequest]).then(([stateResult, mediaResult, devicesResult]) => {
      if (!active) return;
      if (mediaResult.status === "fulfilled") {
        const loaded = mediaResult.value.subjects.map((item, index) => normalizeLoadedAnime(item as Partial<Anime> & Record<string, unknown>, index));
        persistedMediaIds.current = new Set(loaded.map((item) => item.id));
        setAnime(loaded.length ? loaded : seedAnime);
        writeClientCache(MEDIA_CACHE_KEY, loaded);
      }
      if (stateResult.status === "fulfilled") {
        const saved = stateResult.value;
        if (saved) {
          applyState(saved);
          writeClientCache(STATE_CACHE_KEY, saved);
        } else {
          writeClientCache(STATE_CACHE_KEY, null);
        }
      }
      if (devicesResult.status === "fulfilled") {
        const loaded = Array.isArray(devicesResult.value.devices) ? devicesResult.value.devices.map(normalizeLibraryDevice) : seedDevices;
        setDevices(loaded);
        setDevicesPersistable(true);
        writeClientCache(DEVICE_CACHE_KEY, loaded);
      } else {
        setDevicesPersistable(false);
      }
    }).finally(() => { if (active) setStateLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!stateLoaded) return;
    const serverState = { collections, bangumiSyncTypes, syncSettings, mediaOrder, deviceSubCategories, deviceCategoryLabels, visualSubtypeLabels, videoSubtypeLabels, avatarImage: avatarUrl.startsWith("/api/avatar") ? avatarUrl : "", font, softness, backgroundVersion, primaryColor, accentColor, titleMode };
    writeClientCache(STATE_CACHE_KEY, { ...serverState, avatarImage: avatarUrl });
    const timer = window.setTimeout(() => {
      void saveTrackerState(serverState).catch(() => undefined);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [collections, bangumiSyncTypes, syncSettings, mediaOrder, deviceSubCategories, deviceCategoryLabels, visualSubtypeLabels, videoSubtypeLabels, avatarUrl, font, softness, backgroundVersion, primaryColor, accentColor, titleMode, stateLoaded]);

  useEffect(() => {
    if (stateLoaded) writeClientCache(MEDIA_CACHE_KEY, anime);
  }, [anime, stateLoaded]);

  useEffect(() => {
    if (stateLoaded) writeClientCache(DEVICE_CACHE_KEY, devices);
  }, [devices, stateLoaded]);

  const persistAnime = async (item: Anime) => {
    const id = persistedMediaIds.current.has(item.id) ? item.id : undefined;
    try {
      const result = await saveMedia(mediaPayload(item, id));
      if (!result.subject) return;
      const saved = normalizeLoadedAnime(result.subject as Partial<Anime> & Record<string, unknown>);
      persistedMediaIds.current.add(saved.id);
      setAnime((items) => items.map((current) => current.id === item.id ? saved : current));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "媒体保存失败");
    }
  };

  useEffect(() => {
    if (!stateLoaded || coverBackfillStarted.current) return;
    const missing = anime.filter((item) => item.mediaType === "visual" ? !item.thumbnail : item.mediaType === "video" ? false : !item.image || item.image.includes("lain.bgm.tv")).slice(0, 30);
    if (!missing.length) { coverBackfillStarted.current = true; return; }
    coverBackfillStarted.current = true;
    const ids = new Set(missing.map((item) => item.id));
    const timer = window.setTimeout(() => {
      setAnime((items) => {
        const next = items.map((item) => ids.has(item.id) && item.mediaType !== "visual" && item.mediaType !== "video" ? { ...item, image: highResCoverUrl(item.jp || item.title) } : item);
        next.filter((item) => ids.has(item.id) && persistedMediaIds.current.has(item.id)).forEach((item) => { void persistAnime(item); });
        return next;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [anime, stateLoaded]);

  useEffect(() => {
    const bangumiId = !["movie", "tv"].includes(addForm.mediaType) ? parseBangumiSubjectId(query) : undefined;
    const vndbId = addForm.mediaType === "game" ? parseVndbId(query) : undefined;
    if ((!bangumiId && query.trim().length < 2) || !["anime", "game", "light_novel", "manga", "music", "movie", "tv"].includes(addForm.mediaType)) return;
    let active = true;
    if (vndbId && !bangumiId) {
      const timer = window.setTimeout(() => {
        setSearching(true);
        fetchSubjectDetail<SearchResult & { summary?: string; overview?: string; score?: number }>(undefined, undefined, "game", { provider: "vndb", externalId: vndbId }).then((detail) => {
          if (active) setSearchResults([detailToSearchResult(detail)]);
        }).catch(() => {
          if (active) { setSearchResults([]); setToast(`未找到 VNDB 条目 ${vndbId}`); }
        }).finally(() => { if (active) setSearching(false); });
      }, 0);
      return () => { active = false; window.clearTimeout(timer); };
    }
    if (bangumiId) {
      const timer = window.setTimeout(() => {
        setSearching(true);
        fetchSubjectDetail<SearchResult & { summary?: string; overview?: string; score?: number }>(bangumiId, undefined, addForm.mediaType).then((detail) => {
          if (active) setSearchResults([detailToSearchResult(detail)]);
        }).catch(() => {
          if (active) { setSearchResults([]); setToast(`未找到 Bangumi 条目 #${bangumiId}`); }
        }).finally(() => { if (active) setSearching(false); });
      }, 0);
      return () => { active = false; window.clearTimeout(timer); };
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchRemoteAnime<SearchResult>(query.trim(), addForm.mediaType).then((results) => { if (active) setSearchResults(results); }).catch(() => { if (active) setSearchResults([]); }).finally(() => { if (active) setSearching(false); });
    }, 320);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, searchVersion, addForm.mediaType]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2300);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => { writeClientCache(TAG_PREFERENCES_KEY, tagPreferences); }, [tagPreferences]);

  const mediaTags = useMemo(() => {
    const scoped = activeMedia === "all" ? anime : anime.filter((item) => normalizeMediaType(item.mediaType) === activeMedia);
    return Array.from(new Set(scoped.flatMap((item) => item.tags.map((tag) => tagDisplayName(tag, tagPreferences))))).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [anime, activeMedia, tagPreferences]);
  useEffect(() => {
    if (activeTag === "all" || mediaTags.includes(activeTag)) return;
    const timer = window.setTimeout(() => setActiveTag("all"), 0);
    return () => window.clearTimeout(timer);
  }, [activeTag, mediaTags]);
  const musicFacets = useMemo(() => {
    const music = anime.filter((item) => (item.mediaType || "anime") === "music");
    const values = (key: "musicAlbum" | "musicArtist" | "lyricist") => Array.from(new Set(music.map((item) => item[key] || "").filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-CN"));
    return { albums: values("musicAlbum"), artists: values("musicArtist"), lyricists: values("lyricist") };
  }, [anime]);
  const visibleAnime = useMemo(() => anime.filter((item) => {
    const inStatus = activeStatus === "all" || item.status === activeStatus;
    const inMedia = activeMedia === "all" || (item.mediaType || "anime") === activeMedia;
    const inCollection = activeCollection === "all" || item.collection === activeCollection;
    const inTag = activeTag === "all" || item.tags.some((tag) => tagDisplayName(tag, tagPreferences) === activeTag);
    const inSearch = !listQuery.trim() || `${item.title} ${item.jp} ${item.tags.join(" ")} ${(item.characterTags || []).join(" ")} ${item.author || ""} ${item.pixivPid || ""} ${item.musicAlbum || ""} ${item.musicArtist || ""} ${item.lyricist || ""} ${item.composer || ""}`.toLowerCase().includes(listQuery.trim().toLowerCase());
    const inMusicFacet = activeMedia !== "music" || ((musicAlbum === "all" || item.musicAlbum === musicAlbum) && (musicArtist === "all" || item.musicArtist === musicArtist) && (musicLyricist === "all" || item.lyricist === musicLyricist) && (!animeSongsOnly || item.animeSong));
    const inVisualFacet = activeMedia !== "visual" || visualSubtype === "all" || item.visualSubtype === visualSubtype;
    const inVideoFacet = activeMedia !== "video" || videoSubtype === "all" || item.videoSubtype === videoSubtype;
    const passesDroppedFilter = !(activeStatus === "all" && hideDropped && item.status === "dropped");
    const score = ratingScope === "personal" ? (item.score || 0) : ratingScope === "global" ? (item.globalScore || 0) : Math.max(item.score || 0, item.globalScore || 0);
    return inStatus && inMedia && inCollection && inTag && inSearch && inMusicFacet && inVisualFacet && inVideoFacet && passesDroppedFilter && score >= scoreFloor;
  }).sort((a, b) => {
    if (sortMode === "personal") return (b.score || 0) - (a.score || 0);
    if (sortMode === "global") return (b.globalScore || 0) - (a.globalScore || 0);
    if (sortMode === "progress") return (b.progress / Math.max(b.total, 1)) - (a.progress / Math.max(a.total, 1));
    if (sortMode === "title") return a.title.localeCompare(b.title, "zh-CN");
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  }), [anime, activeStatus, activeMedia, activeCollection, activeTag, listQuery, musicAlbum, musicArtist, musicLyricist, animeSongsOnly, visualSubtype, videoSubtype, hideDropped, scoreFloor, ratingScope, sortMode, tagPreferences]);
  const statusCounts = useMemo(() => {
    const counts: Record<Status | "all", number> = { ...archivedCounts, all: 0 };
    anime.forEach((item) => { counts[item.status] += 1; });
    counts.all = counts.watching + counts.wish + counts.finished + counts.library + counts.dropped;
    return counts;
  }, [anime]);
  const activeMediaCounts = useMemo(() => {
    const actual: Record<MediaType, number> = { anime: 0, movie: 0, tv: 0, game: 0, light_novel: 0, manga: 0, music: 0, visual: 0, video: 0 };
    anime.filter((item) => item.status === "watching").forEach((item) => { actual[normalizeMediaType(item.mediaType)] += 1; });
    return actual;
  }, [anime]);
  const activeCollectionTotal = (['anime', 'movie', 'tv', 'game', 'light_novel', 'manga'] as MediaType[]).reduce((sum, type) => sum + activeMediaCounts[type], 0);
  const airingBySubjectId = useMemo(() => new Map(airingSchedules.filter((item) => item.subjectId > 0).map((item) => [item.subjectId, item])), [airingSchedules]);
  const musicTotal = anime.filter((item) => (item.mediaType || "anime") === "music").length;
  const activeDeviceCount = devices.filter((device) => device.status === "active").length;
  const totalInvestment = devices.reduce((sum, device) => sum + (device.price || 0), 0);
  const visibleDevices = useMemo(() => devices.filter((device) => {
    const inCategory = deviceCategoryTab === "all" || device.category === deviceCategoryTab;
    const inSub = deviceSubCategory === "all" || device.subCategory === deviceSubCategory;
    const inStatus = deviceStatusTab === "all" || device.status === deviceStatusTab;
    const inSearch = !listQuery.trim() || `${device.name} ${device.subCategory} ${device.tags.join(" ")}`.toLowerCase().includes(listQuery.trim().toLowerCase());
    return inCategory && inSub && inStatus && inSearch;
  }), [devices, deviceCategoryTab, deviceSubCategory, deviceStatusTab, listQuery]);
  const visibleDeviceSubCategories = useMemo(() => {
    const configured = deviceCategoryTab === "all" ? deviceCategories.flatMap((category) => category.subCategories) : deviceSubCategories[deviceCategoryTab] || [];
    const inUse = devices.filter((device) => deviceCategoryTab === "all" || device.category === deviceCategoryTab).map((device) => device.subCategory).filter(Boolean);
    return Array.from(new Set([...configured, ...inUse]));
  }, [deviceCategoryTab, deviceCategories, deviceSubCategories, devices]);
  const moveMediaTab = (targetIndex: number) => {
    const from = mediaDragIndex.current;
    mediaDragIndex.current = null;
    if (from === null || from === targetIndex) return;
    setMediaOrder((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };
  const removePersistedAnime = async (id: number) => {
    if (!persistedMediaIds.current.has(id)) return;
    try {
      await removeMedia(id);
      persistedMediaIds.current.delete(id);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "媒体删除失败");
    }
  };
  const deleteSelectedAnime = async (ids: number[]) => {
    const uniqueIds = Array.from(new Set(ids)).filter((id) => anime.some((item) => item.id === id));
    if (!uniqueIds.length) return false;
    if (!window.confirm(`确定删除选中的 ${uniqueIds.length} 个收藏吗？删除后无法恢复。`)) return false;
    const results = await Promise.allSettled(uniqueIds.map(async (id) => {
      if (persistedMediaIds.current.has(id)) await removeMedia(id);
      return id;
    }));
    const succeeded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failed = results.length - succeeded.length;
    if (succeeded.length) {
      const deleted = new Set(succeeded);
      succeeded.forEach((id) => persistedMediaIds.current.delete(id));
      setAnime((items) => items.filter((item) => !deleted.has(item.id)));
    }
    if (failed) {
      setToast(`${succeeded.length} 项已删除，${failed} 项删除失败`);
      return false;
    }
    setToast(`已删除 ${succeeded.length} 项收藏`);
    return true;
  };
  const openCalendar = (day: CalendarDay = "all") => {
    // Keep the old interaction: the weekly schedule opens as a secondary
    // window over the library instead of navigating away from the page.
    setCalendarDay(day);
    setModal("calendar");
  };
  const openDetails = (id: number) => { setDetailId(id); setModal("detail"); };
  const closeSecondary = (after?: () => void) => {
    if (!modal || closingModal) return;
    const closing = modal;
    setClosingModal(closing);
    window.setTimeout(() => {
      setModal(null); setClosingModal(null);
      if (closing === "complete") setCompletionId(null);
      if (closing === "detail") setDetailId(null);
      if (closing === "device") setDeviceForm(null);
      if (closing === "receipt") setReceiptPreview(null);
      after?.();
    }, 190);
  };
  const rateAnime = (id: number, score: number) => {
    const current = anime.find((item) => item.id === id);
    if (current) void persistAnime({ ...current, score, updatedAt: Date.now() });
    setAnime((items) => items.map((item) => item.id === id ? { ...item, score, updatedAt: Date.now() } : item));
    setToast(`已评分 ${score} · ${scoreLabels[score]}`);
  };

  const adjust = (id: number, delta: number) => {
    const current = anime.find((item) => item.id === id);
    const nextProgress = current ? Math.min(current.total, Math.max(0, current.progress + delta)) : 0;
    if (current) void persistAnime({ ...current, progress: nextProgress, status: current.status === "wish" && nextProgress > 0 ? "watching" : current.status, updatedAt: Date.now() });
    setAnime((items) => items.map((item) => item.id === id ? { ...item, progress: nextProgress, status: item.status === "wish" && nextProgress > 0 ? "watching" : item.status, updatedAt: Date.now() } : item));
    if (current && delta > 0 && current.status !== "finished" && nextProgress >= current.total) {
      setCompletionId(id);
      setModal("complete");
      return;
    }
    setToast(delta > 0 ? "已记录一集" : "已撤销一集");
  };
  const completeAnime = () => {
    if (completionId === null) return;
    const current = anime.find((item) => item.id === completionId);
    if (current) void persistAnime({ ...current, progress: current.total, status: "finished", updatedAt: Date.now() });
    setAnime((items) => items.map((item) => item.id === completionId ? { ...item, progress: item.total, status: "finished", updatedAt: Date.now() } : item));
    closeSecondary(() => setActiveStatus("finished"));
    setToast("已标记为已完成");
  };
  const chooseSearch = async (result: SearchResult) => {
    const mediaType = addForm.mediaType;
    const isTmdb = result.source === "tmdb" && (mediaType === "movie" || mediaType === "tv");
    const isVndb = result.source === "vndb" && mediaType === "game";
    const selectedId = result.tmdbId || result.id;
    setAddForm((form) => ({
      ...form,
      title: result.title,
      jp: result.originalTitle || result.jp,
      total: result.total || (form.mediaType === "game" ? 100 : form.mediaType === "movie" ? 1 : 12),
      image: result.coverImage || result.image || (form.mediaType === "anime" ? highResCoverUrl(result.jp || result.title) : ""),
      note: result.overview || form.note,
      globalScore: result.rating && result.rating > 0 ? result.rating : form.globalScore,
      source: isTmdb ? "manual" : isVndb ? "vndb" : "bangumi",
      subjectId: isTmdb ? undefined : result.id,
      metadata: normalizeMediaMetadata({ ...form.metadata, ...(result.metadata || {}), ...(isTmdb ? { tmdbId: selectedId, backdropImage: result.backdropImage, overview: result.overview, originalTitle: result.originalTitle, genres: result.genres, year: result.year, provider: "tmdb" } : isVndb ? { vndbId: result.externalId || result.metadata?.vndbId, vndbUrl: result.externalId ? `https://vndb.org/${result.externalId}` : result.metadata?.vndbUrl, provider: "vndb" } : {}) }),
    }));
    setQuery("");
    setSearchResults([]);
    if (!isTmdb && !isVndb) return;
    try {
      const detail = await fetchSubjectDetail<SearchResult & { summary?: string; score?: number; metadata?: AddForm["metadata"] }>(selectedId, undefined, mediaType, isVndb ? { provider: "vndb", externalId: result.externalId || result.metadata?.vndbId } : {});
      setAddForm((form) => ({
        ...form,
        title: detail.title || form.title,
        jp: detail.originalTitle || detail.jp || form.jp,
        total: detail.total || form.total,
        image: detail.coverImage || detail.image || form.image,
        note: detail.overview || detail.summary || form.note,
        globalScore: detail.rating && detail.rating > 0 ? detail.rating : detail.score && detail.score > 0 ? detail.score : form.globalScore,
        metadata: normalizeMediaMetadata({ ...form.metadata, ...(detail.metadata || {}), ...(isVndb ? { vndbId: detail.externalId || result.externalId || result.metadata?.vndbId, vndbUrl: result.externalId ? `https://vndb.org/${result.externalId}` : result.metadata?.vndbUrl, provider: "vndb" } : { tmdbId: detail.tmdbId || selectedId, backdropImage: detail.backdropImage, overview: detail.overview || detail.summary, originalTitle: detail.originalTitle || detail.jp, genres: detail.genres, provider: "tmdb" }) }),
      }));
    } catch {
      setToast(`${isVndb ? "VNDB" : "TMDB"} 详情读取失败，已保留搜索结果`);
    }
  };
  const openDeviceEditor = (device: Device | null) => {
    setDeviceDraft(device);
    setDeviceForm(device ? {
      name: device.name, category: device.category, subCategory: device.subCategory, status: device.status,
      price: device.price != null ? String(device.price) : "", purchaseDate: device.purchaseDate || "",
      receiptImage: device.receiptImage, coverImage: device.coverImage, tags: device.tags.join("，"),
      rating: device.rating != null ? String(device.rating) : "", review: device.review,
    } : { name: "", category: deviceCategories[0]?.id || "audio", subCategory: "", status: "active", price: "", purchaseDate: "", receiptImage: "", coverImage: "", tags: "", rating: "", review: "" });
    setModal("device");
  };
  const openDeviceCategoryManager = () => {
    setDeviceCategoryManagerTab(deviceCategoryTab === "all" ? deviceCategories[0]?.id || "audio" : deviceCategoryTab);
    setModal("device_categories");
  };
  const submitDevice = async () => {
    if (!deviceForm) return;
    if (!deviceForm.name.trim()) { setToast("请填写设备名称"); return; }
    const device: Device = {
      id: deviceDraft?.id || Date.now(),
      name: deviceForm.name.trim(),
      category: deviceForm.category,
      subCategory: deviceForm.subCategory,
      status: deviceForm.status,
      price: deviceForm.price !== "" && Number.isFinite(Number(deviceForm.price)) ? Math.max(0, Math.round(Number(deviceForm.price) * 100) / 100) : null,
      currency: "CNY",
      purchaseDate: deviceForm.purchaseDate || null,
      receiptImage: deviceForm.receiptImage.trim(),
      coverImage: deviceForm.coverImage.trim(),
      tags: deviceForm.tags.split(/[,，、\s]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 12),
      rating: deviceForm.rating !== "" && Number.isInteger(Number(deviceForm.rating)) ? Math.min(10, Math.max(1, Number(deviceForm.rating))) : null,
      review: deviceForm.review.trim(),
      updatedAt: Date.now(),
    };
    const isNew = !deviceDraft;
    const localId = device.id;
    setDevices((items) => isNew ? [device, ...items] : items.map((item) => item.id === localId ? device : item));
    closeSecondary();
    setToast(isNew ? "设备已加入装备库" : "设备信息已更新");
    if (!devicesPersistable) return;
    try {
      const payload = await saveDevice({ id: deviceDraft?.id, name: device.name, category: device.category, subCategory: device.subCategory, status: device.status, price: device.price, currency: device.currency, purchaseDate: device.purchaseDate, receiptImage: device.receiptImage, coverImage: device.coverImage, tags: device.tags, rating: device.rating, review: device.review });
      if (payload?.device) setDevices((items) => items.map((item) => item.id === localId ? normalizeLibraryDevice(payload.device) : item));
    } catch {
      setDevicesPersistable(false);
      setToast("云端暂不可用，设备已保存在本页");
    }
  };
  const deleteDevice = async (id: number) => {
    setDevices((items) => items.filter((item) => item.id !== id));
    setToast("设备已移出装备库");
    if (!devicesPersistable) return;
    try {
      await removeDevice(id);
    } catch {
      setDevicesPersistable(false);
    }
  };
  const openReceipt = (device: Device) => { setReceiptPreview(device); setModal("receipt"); };
  const triggerSearch = () => {
    const isDirectId = !["movie", "tv"].includes(addForm.mediaType) && Boolean(parseBangumiSubjectId(query) || (addForm.mediaType === "game" && parseVndbId(query)));
    if (query.trim().length < 2 && !isDirectId) { setToast("请输入 Bangumi/VNDB ID 或至少两个字再搜索"); return; }
    setSearchVersion((version) => version + 1);
  };
  const uploadImageAsset = async (file?: File): Promise<string | null> => {
    if (!file) return null;
    setThumbnailUploading(true);
    try {
      const payload = await uploadMediaImage(file);
      setToast("图片已压缩并上传");
      return payload.url;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "缩略图上传失败");
      return null;
    } finally {
      setThumbnailUploading(false);
    }
  };
  const openVisualSubtypeManager = (returnTo: "add" | "library" = "library") => { setVisualSubtypeReturn(returnTo); setModal("visual_subtypes"); };
  const closeVisualSubtypeManager = () => { const returnTo = visualSubtypeReturn; setVisualSubtypeReturn(null); closeSecondary(() => { if (returnTo === "add") setModal("add"); }); };
  const openVideoSubtypeManager = (returnTo: "add" | "library" = "library") => { setVideoSubtypeReturn(returnTo); setModal("video_subtypes"); };
  const closeVideoSubtypeManager = () => { const returnTo = videoSubtypeReturn; setVideoSubtypeReturn(null); closeSecondary(() => { if (returnTo === "add") setModal("add"); }); };
  const addAnime = () => {
    if (!addForm.title.trim()) return setToast("请填写收藏名称");
    const setting = mediaSettings[addForm.mediaType];
    const isMusic = addForm.mediaType === "music";
    const isVisual = addForm.mediaType === "visual";
    const isMovie = addForm.mediaType === "movie";
    const isVideo = addForm.mediaType === "video";
    const metadata = normalizeMediaMetadata({ ...addForm.metadata, videoSource: isVideo ? addForm.source.trim() : addForm.metadata.videoSource });
    const newItem: Anime = { id: Date.now(), title: addForm.title.trim(), jp: addForm.jp || "", note: addForm.note || "手动加入月下集", progress: 0, total: isMusic || isVisual || isMovie || isVideo ? 1 : addForm.total || (addForm.mediaType === "game" ? 100 : 12), status: addForm.status, kind: "coral", score: undefined, image: isVisual ? undefined : addForm.image.trim() || (addForm.mediaType === "anime" ? highResCoverUrl(addForm.jp || addForm.title) : ""), thumbnail: isVisual || isVideo ? addForm.thumbnail.trim() : undefined, subjectId: isVisual || addForm.mediaType === "tv" || isMovie || isVideo ? undefined : addForm.subjectId, mediaType: addForm.mediaType, unit: setting.unit, globalScore: addForm.globalScore, source: isVideo ? "manual" : normalizeMediaSource(addForm.source, addForm.subjectId ? "bangumi" : "manual"), collection: addForm.collection || "", tags: splitTags(addForm.tags), musicAlbum: isMusic ? addForm.musicAlbum.trim() : "", musicArtist: isMusic ? addForm.musicArtist.trim() : "", lyricist: isMusic ? addForm.lyricist.trim() : "", composer: isMusic ? addForm.composer.trim() : "", animeSong: isMusic && addForm.animeSong, visualSubtype: isVisual ? addForm.visualSubtype : "other", videoSubtype: isVideo ? normalizeVideoSubtype(addForm.videoSubtype) : "other", sourceUrl: isVisual || isVideo ? addForm.sourceUrl.trim() : "", pixivPid: isVisual ? addForm.pixivPid.trim() : "", author: isVisual ? addForm.author.trim() : "", twitterSource: isVisual ? addForm.twitterSource.trim() : "", characterTags: isVisual ? addForm.characterTags.split(/[,，、\s]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 30) : [], metadata, updatedAt: Date.now() };
    setAnime((items) => [...items, newItem]);
    void persistAnime(newItem);
    closeSecondary(); setAddForm({ title: "", jp: "", total: 12, status: "watching", note: "", image: "", thumbnail: "", mediaType: "anime", collection: "", tags: "", musicAlbum: "", musicArtist: "", lyricist: "", composer: "", source: "", animeSong: false, visualSubtype: "other", videoSubtype: "other", sourceUrl: "", pixivPid: "", author: "", twitterSource: "", characterTags: "", metadata: normalizeMediaMetadata() }); setQuery(""); setToast(isMusic ? "单曲已加入月下集" : isVisual ? "视觉收藏已加入画廊" : isVideo ? "视频已加入月下集" : "已加入月下集");
  };
  const createCollection = () => {
    const name = collectionName.trim();
    if (!name) { setToast("请输入合集名称"); return; }
    if (collections.includes(name)) { setToast("这个合集已经存在"); return; }
    setCollections((items) => [...items, name]);
    setActiveCollection(name);
    setCollectionName("");
    closeSecondary();
    setToast(`已创建合集「${name}」`);
  };
  const selectCollection = (name: string) => setActiveCollection(name);
  const toggleCalendarTracking = (entry: CalendarEntry) => {
    const existing = anime.find((item) => (entry.subjectId && item.subjectId === entry.subjectId) || item.title === entry.title || (item.jp && item.jp === entry.jp));
    if (existing) {
      setAnime((items) => items.filter((item) => item.id !== existing.id));
      void removePersistedAnime(existing.id);
      setToast("已取消追更");
      return;
    }
    const newItem: Anime = {
      id: Date.now(), title: entry.title, jp: entry.jp, subjectId: entry.subjectId, note: `从星期${entry.day}放送表加入`, progress: 0, total: 12,
      status: "watching", kind: "coral", image: entry.coverUrl || highResCoverUrl(entry.coverQuery), next: entry.meta.split("·").slice(0, 2).join("·"), mediaType: "anime", unit: "集", source: "bangumi", collection: "", tags: ["放送追更"], updatedAt: Date.now(),
    };
    setAnime((items) => [...items, newItem]);
    void persistAnime(newItem);
    setToast("已加入追番并保存到合集");
  };
  const saveDetails = (updated: Anime) => {
    setAnime((items) => items.map((item) => item.id === updated.id ? updated : item));
    void persistAnime(updated);
    closeSecondary(); setToast("修改已保存");
  };
  const removeAnime = (id: number) => {
    setAnime((items) => items.filter((item) => item.id !== id));
    void removePersistedAnime(id);
    closeSecondary(); setToast("条目已移除");
  };
  const uploadBackground = async (file?: File) => {
    if (!file) return;
    try {
      const payload = await uploadCustomBackground(file);
      setBackgroundVersion(payload.version); setToast("背景已保存");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "上传失败");
    }
  };
  const chooseAvatar = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setToast("请选择图片文件"); return; }
    if (file.size > 2 * 1024 * 1024) { setToast("头像图片不能超过 2 MB"); return; }
    try {
      const payload = await uploadAvatar(file);
      setAvatarUrl(payload.url);
      setToast("头像已更新并保存");
      return;
    } catch {
      // 未登录或本地开发环境无法使用对象存储时，保留浏览器本地头像。
    }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") { setAvatarUrl(reader.result); setToast("头像已更新"); } };
    reader.onerror = () => setToast("头像读取失败");
    reader.readAsDataURL(file);
  };
  const resetAvatar = () => { setAvatarUrl(""); setToast("已恢复默认头像"); };
  const refreshBangumi = async () => {
    const result = await refreshBangumiRecords(anime, bangumiSyncTypes, undefined, syncSettings);
    setAnime(result.anime);
    result.anime.filter((item) => persistedMediaIds.current.has(item.id)).forEach((item) => { void persistAnime(item); });
    return result.count;
  };
  const toggleSyncSetting = (provider: SyncProvider, field: SyncField) => {
    setSyncSettings((current) => ({ ...current, [provider]: { ...current[provider], [field]: !current[provider][field] } }));
  };
  const reloadMediaLibrary = async () => {
    const payload = await loadMedia();
    const loaded = payload.subjects.map((item, index) => normalizeLoadedAnime(item as Partial<Anime> & Record<string, unknown>, index));
    persistedMediaIds.current = new Set(loaded.map((item) => item.id));
    setAnime(loaded.length ? loaded : seedAnime);
    return loaded.length;
  };
  const syncBangumiAccount = async (direction: "pull" | "push", types: MediaType[]) => {
    const response = await fetch("/api/bangumi/account/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction, types }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; details?: string; synced?: number; failed?: number };
    if (!response.ok) throw new Error([payload.error || "Bangumi 账号同步失败", payload.details].filter(Boolean).join("："));
    if (direction === "pull") await reloadMediaLibrary();
    return { synced: Number(payload.synced) || 0, failed: Number(payload.failed) || 0 };
  };
  const runSync = async (target: SyncTarget) => {
    if (syncing) return;
    if (target === "bangumi_push" && !window.confirm("将月下集中由 Bangumi 管理的条目状态、评分、标签、备注和动画进度写入 Bangumi。确认继续？")) return;
    setSyncing(target);
    try {
      if (target === "bangumi") {
        setToast(`Bangumi 已刷新 ${await refreshBangumi()} 部`);
      } else {
        const direction = target === "bangumi_pull" ? "pull" : "push";
        const result = await syncBangumiAccount(direction, bangumiSyncTypes);
        setToast(`${direction === "pull" ? "Bangumi 导入" : "Bangumi 写回"}完成：成功 ${result.synced} 条${result.failed ? `，失败 ${result.failed} 条` : ""}`);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "同步失败，请稍后重试");
    } finally {
      setSyncing(null);
      setSyncDialogTarget(null);
    }
  };
  const openSyncDialog = (target: SyncTarget) => { setModal(null); setSyncDialogTarget(target); };

  return <main className={`app-shell font-${font} ${closingModal ? "secondary-closing" : ""}`} style={{ "--softness": softness / 100, "--primary": primaryColor, "--accent": accentColor } as React.CSSProperties}>
    {backgroundVersion > 0 && <div className="custom-background" style={{ backgroundImage: `url("${customBackgroundUrl(backgroundVersion)}")` }} />}
    <header className="topbar"><div className="topbar-inner">
      <button className="brand" onClick={() => { setActiveView("acg"); setActiveStatus("watching"); setActiveMedia("all"); setActiveCollection("all"); setActiveTag("all"); }}><i />月下集</button>
      <nav className="desktop-nav" aria-label="一级导航"><button className={activeView === "acg" ? "active" : ""} onClick={() => setActiveView("acg")}>ACGNM</button><button className={activeView === "devices" ? "active" : ""} onClick={() => setActiveView("devices")}>装备库</button></nav>
      <label className="library-search"><span>⌕</span><input value={listQuery} onChange={(event) => setListQuery(event.target.value)} placeholder={activeView === "devices" ? "搜索设备、标签或子类" : "搜索我的收藏"} /></label>
      <div className="header-actions"><button className="icon-button health-dot" onClick={() => setModal("connectivity")} aria-label="连通性检查"><i /></button><button className={`quiet-button sync-trigger ${modal === "sync" ? "open" : ""}`} onClick={() => modal === "sync" ? closeSecondary() : setModal("sync")} aria-expanded={modal === "sync"}><span className="button-label">同步</span><i className="sync-chevron" aria-hidden="true" /></button><button className="primary-button add-trigger" onClick={() => activeView === "devices" ? openDeviceEditor(null) : setModal("add")}><span className="plus-icon" aria-hidden="true">＋</span><span className="button-label">添加</span></button><button className="avatar" onClick={() => setModal("settings")} aria-label="打开偏好设置">{avatarUrl ? <img src={avatarUrl} alt="自定义头像" /> : "泽"}</button>{modal === "sync" && <><button className="popover-dismiss" onClick={() => closeSecondary()} aria-label="关闭同步菜单" /><SyncMenu close={() => closeSecondary()} syncing={syncing} open={openSyncDialog} /></>}</div>
    </div></header>
    <nav className="mobile-view-tabs" aria-label="一级导航"><button className={activeView === "acg" ? "active" : ""} onClick={() => setActiveView("acg")}>ACGNM</button><button className={activeView === "devices" ? "active" : ""} onClick={() => setActiveView("devices")}>装备库</button></nav>

    <div className="page-wrap">
        <CollectionSummary beijingTime={beijingTime} activeCollectionTotal={activeCollectionTotal} activeMediaCounts={activeMediaCounts} activeDeviceCount={activeDeviceCount} totalInvestment={totalInvestment} musicTotal={musicTotal} />
      {activeView === "acg" ? <MediaLibrary
        anime={anime} visibleAnime={visibleAnime} collections={collections} activeStatus={activeStatus} setActiveStatus={setActiveStatus} statusCounts={statusCounts}
        activeMedia={activeMedia} setActiveMedia={setActiveMedia} mediaOrder={mediaOrder} mediaDragIndex={mediaDragIndex} moveMediaTab={moveMediaTab}
        activeCollection={activeCollection} setActiveCollection={setActiveCollection} selectCollection={selectCollection} openCollectionManager={() => setModal("collection_manager")}
        openAdd={() => setModal("add")} openCollection={() => setModal("collection")} openVisualSubtypeManager={openVisualSubtypeManager} acgLayout={acgLayout} setAcgLayout={setAcgLayout}
        ratingScope={ratingScope} setRatingScope={setRatingScope} scoreFloor={scoreFloor} setScoreFloor={setScoreFloor} activeTag={activeTag} setActiveTag={setActiveTag} tagPreferences={tagPreferences} setTagPreferences={setTagPreferences} hideDropped={hideDropped} setHideDropped={setHideDropped} sortMode={sortMode} setSortMode={setSortMode}
        musicFacets={musicFacets} musicAlbum={musicAlbum} setMusicAlbum={setMusicAlbum} musicArtist={musicArtist} setMusicArtist={setMusicArtist} musicLyricist={musicLyricist} setMusicLyricist={setMusicLyricist} animeSongsOnly={animeSongsOnly} setAnimeSongsOnly={setAnimeSongsOnly} visualSubtype={visualSubtype} setVisualSubtype={setVisualSubtype} visualSubtypeLabels={visualSubtypeLabels} videoSubtype={videoSubtype} setVideoSubtype={setVideoSubtype} videoSubtypeLabels={videoSubtypeLabels} openVideoSubtypeManager={openVideoSubtypeManager}
        onAdjust={adjust} onDetails={openDetails} onRate={rateAnime} onBatchDelete={deleteSelectedAnime} titleMode={titleMode} openCalendar={openCalendar} toggleCalendarTracking={toggleCalendarTracking} airingSchedules={airingSchedules} airingBySubjectId={airingBySubjectId}
      /> : <DeviceLibrary
        devices={devices} visibleDevices={visibleDevices} activeCount={activeDeviceCount} totalInvestment={totalInvestment} categoryTab={deviceCategoryTab} setCategoryTab={setDeviceCategoryTab} categories={deviceCategories} categoryLabels={deviceCategoryLabels} statusTab={deviceStatusTab} setStatusTab={setDeviceStatusTab} visibleSubCategories={visibleDeviceSubCategories} subCategory={deviceSubCategory} setSubCategory={setDeviceSubCategory} openCategoryManager={openDeviceCategoryManager} layout={deviceLayout} setLayout={setDeviceLayout} openEditor={openDeviceEditor} onDelete={deleteDevice} onReceipt={openReceipt}
      />}
    </div>

    <nav className="mobile-nav"><button className={activeView === "acg" ? "active" : ""} onClick={() => { setActiveView("acg"); setActiveStatus("watching"); setActiveMedia("all"); }}><i>◇</i><span>首页</span></button><button onClick={() => openCalendar()}><i>◷</i><span>日历</span></button><button className="mobile-nav-add" onClick={() => activeView === "devices" ? openDeviceEditor(null) : setModal("add")}><i>＋</i><span>添加</span></button><button onClick={() => { setActiveView("acg"); setModal("add"); }}><i>⌕</i><span>搜索</span></button><button onClick={() => setModal("settings")}><i>○</i><span>我的</span></button></nav>
    {modal === "add" && <AddModal query={query} setQuery={(value) => { setQuery(value); if (value.trim().length < 2) { setSearchResults([]); setSearching(false); } }} search={triggerSearch} searching={searching} results={searchResults} choose={chooseSearch} form={addForm} setForm={setAddForm} collections={collections} close={() => closeSecondary()} submit={addAnime} uploadImage={uploadImageAsset} thumbnailUploading={thumbnailUploading} visualSubtypeLabels={visualSubtypeLabels} openVisualSubtypeManager={(returnTo) => openVisualSubtypeManager(returnTo || "add")} videoSubtypeLabels={videoSubtypeLabels} openVideoSubtypeManager={(returnTo) => openVideoSubtypeManager(returnTo || "add")} />}
    {modal === "collection" && <CollectionModal name={collectionName} setName={setCollectionName} close={() => closeSecondary()} submit={createCollection} />}
    {modal === "collection_manager" && <CollectionManagerModal collections={collections} close={() => closeSecondary()} save={(next) => { const removed = new Set(collections.filter((name) => !next.includes(name))); setCollections(next); if (removed.size) { const affected = anime.filter((item) => item.collection && removed.has(item.collection)); setAnime((items) => items.map((item) => item.collection && removed.has(item.collection) ? { ...item, collection: "", updatedAt: Date.now() } : item)); affected.forEach((item) => { void persistAnime({ ...item, collection: "", updatedAt: Date.now() }); }); } if (activeCollection !== "all" && !next.includes(activeCollection)) setActiveCollection("all"); closeSecondary(); setToast("合集顺序已保存"); }} />}
    {modal === "settings" && <SettingsModal
      font={font} setFont={setFont}
      avatarUrl={avatarUrl} chooseAvatar={chooseAvatar} resetAvatar={resetAvatar}
      primaryColor={primaryColor} setPrimaryColor={setPrimaryColor}
      accentColor={accentColor} setAccentColor={setAccentColor}
      softness={softness} setSoftness={setSoftness}
      titleMode={titleMode} setTitleMode={setTitleMode}
      uploadBackground={uploadBackground}
      syncSettings={syncSettings}
      toggleSyncSetting={toggleSyncSetting}
      close={() => closeSecondary()}
    />}
    {syncDialogTarget && <SyncModal target={syncDialogTarget} close={() => { if (!syncing) setSyncDialogTarget(null); }} run={runSync} syncing={syncing} bangumiSyncTypes={bangumiSyncTypes} toggleBangumiType={(type) => setBangumiSyncTypes((types) => types.includes(type) ? types.filter((item) => item !== type) : [...types, type])} />}
    {modal === "connectivity" && <ConnectivityModal close={() => closeSecondary()} />}
    {modal === "calendar" && <CalendarModal initialDay={calendarDay} close={() => closeSecondary()} titleMode={titleMode} anime={anime} airingSchedules={airingSchedules} toggle={toggleCalendarTracking} refreshSchedules={refreshAiringSchedules} />}
    {modal === "complete" && completionId !== null && <CompletionModal item={anime.find((item) => item.id === completionId)} close={() => closeSecondary()} confirm={completeAnime} />}
    {modal === "detail" && detailId !== null && <DetailDrawer key={detailId} item={anime.find((item) => item.id === detailId)} collections={collections} close={() => closeSecondary()} save={saveDetails} remove={removeAnime} uploadImage={uploadImageAsset} imageUploading={thumbnailUploading} visualSubtypeLabels={visualSubtypeLabels} videoSubtypeLabels={videoSubtypeLabels} syncSettings={syncSettings} />}
    {modal === "visual_subtypes" && <VisualSubtypeModal labels={visualSubtypeLabels} close={closeVisualSubtypeManager} save={(labels) => { const returnTo = visualSubtypeReturn; const nextLabels = normalizeVisualSubtypeLabels(labels); const allowed = new Set(Object.keys(nextLabels)); setVisualSubtypeLabels(nextLabels); setVisualSubtype((current) => current !== "all" && !allowed.has(current) ? "all" : current); const affected = anime.filter((item) => item.mediaType === "visual" && item.visualSubtype && !allowed.has(item.visualSubtype)); setAnime((items) => items.map((item) => item.mediaType === "visual" && item.visualSubtype && !allowed.has(item.visualSubtype) ? { ...item, visualSubtype: "other", updatedAt: Date.now() } : item)); affected.forEach((item) => { void persistAnime({ ...item, visualSubtype: "other", updatedAt: Date.now() }); }); setVisualSubtypeReturn(null); closeSecondary(() => { if (returnTo === "add") setModal("add"); }); setToast("画廊子类型已保存"); }} />}
    {modal === "video_subtypes" && <VideoSubtypeModal labels={videoSubtypeLabels} close={closeVideoSubtypeManager} save={(labels) => { const returnTo = videoSubtypeReturn; const nextLabels = normalizeVideoSubtypeLabels(labels); const allowed = new Set(Object.keys(nextLabels)); setVideoSubtypeLabels(nextLabels); setVideoSubtype((current) => current !== "all" && !allowed.has(current) ? "all" : current); const affected = anime.filter((item) => item.mediaType === "video" && item.videoSubtype && !allowed.has(item.videoSubtype)); setAnime((items) => items.map((item) => item.mediaType === "video" && item.videoSubtype && !allowed.has(item.videoSubtype) ? { ...item, videoSubtype: "other", updatedAt: Date.now() } : item)); affected.forEach((item) => { void persistAnime({ ...item, videoSubtype: "other", updatedAt: Date.now() }); }); setVideoSubtypeReturn(null); closeSecondary(() => { if (returnTo === "add") setModal("add"); }); setToast("视频子分类已保存"); }} />}
    {modal === "device" && deviceForm && <DeviceModal form={deviceForm} setForm={setDeviceForm} device={deviceDraft} categories={deviceCategories} subCategories={deviceSubCategories} close={() => closeSecondary()} submit={() => void submitDevice()} />}
    {modal === "device_categories" && <DeviceSubCategoryModal value={deviceSubCategories} categoryLabels={deviceCategoryLabels} initialCategory={deviceCategoryManagerTab} close={() => closeSecondary()} toast={setToast} save={(value, labels) => { const nextLabels = normalizeDeviceCategoryLabels(labels); const nextCategories = deviceCategoriesForPreferences(nextLabels, value); setDeviceSubCategories(value); setDeviceCategoryLabels(nextLabels); if (deviceCategoryTab !== "all" && !nextCategories.some((category) => category.id === deviceCategoryTab)) setDeviceCategoryTab("all"); if (deviceCategoryManagerTab && !nextCategories.some((category) => category.id === deviceCategoryManagerTab)) setDeviceCategoryManagerTab(nextCategories[0]?.id || "audio"); if (deviceSubCategory !== "all" && !Object.values(value).flat().includes(deviceSubCategory)) setDeviceSubCategory("all"); closeSecondary(); setToast("设备分类名称与子类顺序已保存"); }} />}
    {modal === "receipt" && receiptPreview && <ReceiptModal device={receiptPreview} close={() => closeSecondary()} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </main>;
}
