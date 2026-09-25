import { MEDIA_CATEGORIES } from "./constants";
import type { MediaTab, MediaType, Status } from "./tracker-types";

export const primaryStatusMeta = [["watching", "进行中"], ["wish", "未开始"], ["finished", "已完成"]] as const;
export const secondaryStatusMeta = [["library", "搁置"], ["dropped", "抛弃"]] as const;
export const mediaMeta: Array<[MediaType | "all", string, string]> = [["all", "全部", "◇"], ...MEDIA_CATEGORIES.map((item) => [item.id, item.label, item.icon] as [MediaType, string, string])];
export const defaultMediaOrder: MediaTab[] = mediaMeta.map(([id]) => id);
export function normalizeMediaOrder(value?: unknown[]) {
  const allowed = new Set<MediaTab>(defaultMediaOrder);
  const saved = Array.isArray(value) ? value.filter((id): id is MediaTab => typeof id === "string" && allowed.has(id as MediaTab)) : [];
  const ordered = Array.from(new Set([...saved, ...defaultMediaOrder]));
  return [...ordered.filter((id) => id === "all"), ...ordered.filter((id) => id !== "all")];
}

export const mediaSettings: Record<MediaType, { unit: string; action: string; step: number; sources: string }> = {
  anime: { unit: "集", action: "记录一集", step: 1, sources: "bangumi" },
  movie: { unit: "部", action: "标记看过", step: 1, sources: "TMDB / manual" },
  tv: { unit: "集", action: "记录一集", step: 1, sources: "TMDB / manual" },
  game: { unit: "%", action: "更新 +5%", step: 5, sources: "Bangumi / VNDB" },
  light_novel: { unit: "卷", action: "读完一卷", step: 1, sources: "Bangumi / AniList / NDL / Google Books / Open Library" },
  manga: { unit: "话", action: "记录一话", step: 1, sources: "Bangumi / AniList / MangaDex" },
  music: { unit: "", action: "", step: 0, sources: "manual" },
  visual: { unit: "", action: "", step: 0, sources: "manual / local" },
  video: { unit: "", action: "", step: 0, sources: "manual" },
};

export const defaultCollections: string[] = [];
const legacyDefaultCollections = new Set(["逐光绮绘", "异界溯行", "墨痕浅酌", "夜聆心曲", "本季精选", "叙事游戏", "慢慢读", "夜间播放"]);
const collectionAliases: Record<string, string> = { 本季精选: "逐光绮绘", 叙事游戏: "异界溯行", 慢慢读: "墨痕浅酌", 夜间播放: "夜聆心曲" };
export const normalizeCollectionName = (value?: string) => value ? collectionAliases[value] || value : "";
export const sanitizeCollectionName = (value?: string) => {
  const normalized = normalizeCollectionName(value);
  return legacyDefaultCollections.has(value || "") || legacyDefaultCollections.has(normalized) ? "" : normalized;
};

export function formatBeijingTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${get("month")}月${get("day")}日 · ${get("weekday").replace("周", "星期")} · 北京时间 ${get("hour")}:${get("minute")}`;
}

export const archivedCounts: Record<Status, number> = { watching: 0, wish: 0, finished: 0, library: 0, dropped: 0 };
export const week = ["一", "二", "三", "四", "五", "六", "日"] as const;

export const scoreLabels = ["未评分", "不忍直视", "很差", "差", "较差", "不过不失", "还行", "推荐", "力荐", "神作", "超神作"];
export const splitTags = (value: string) => Array.from(new Set(value.split(/[,，、\s]+/).map((tag) => tag.trim()).filter(Boolean))).slice(0, 30);
