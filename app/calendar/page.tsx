"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { highResCoverUrl, loadAiringSchedules, syncAiringSchedules, type AiringSyncProgress } from "../lib/client-api";
import { formatAiringCountdown, formatWeekday } from "../lib/anime-airing-time";
import type { AiringSchedule } from "../lib/tracker-types";
import { CoverImage } from "../components/tracker/common";

const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;
const stageLabels: Record<string, string> = {
  preparing: "准备同步",
  parsing: "正在解析番剧列表",
  matching: "正在匹配我的追番",
  saving: "正在保存放送计划",
  complete: "同步完成",
};

const sourceLabels: Record<string, string> = { all: "全部来源", bangumi: "Bangumi 官方", anilist: "AniList 补充", animeschedule: "AnimeSchedule", custom: "用户自定义" };

function coverFor(item: AiringSchedule) {
  const images = item.metadata?.images;
  if (images && typeof images === "object") {
    const value = (images as Record<string, unknown>).large || (images as Record<string, unknown>).common || (images as Record<string, unknown>).medium;
    if (typeof value === "string" && value) return value.replace(/^http:\/\//i, "https://");
  }
  return highResCoverUrl(item.jpTitle || item.title);
}

function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function CalendarPage() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<AiringSchedule[]>([]);
  const [season, setSeason] = useState("");
  const [year, setYear] = useState<number>();
  const [source, setSource] = useState("all");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncStage, setSyncStage] = useState("");

  const load = useCallback(async (nextSource = source) => {
    const payload = await loadAiringSchedules({ source: nextSource === "all" ? undefined : nextSource });
    setSchedules(payload.schedules || []);
    setSeason(payload.season);
    setYear(payload.year);
  }, [source]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      void load().catch((error) => setMessage(error instanceof Error ? error.message : "无法读取放送计划"));
    }, 0);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { window.clearTimeout(loadTimer); window.clearInterval(timer); };
  }, [load]);

  const groups = useMemo(() => new Map(weekdays.map((weekday) => [
    weekday,
    schedules
      .filter((item) => item.weekday === weekday)
      .sort((a, b) => Number(b.isCollected) - Number(a.isCollected) || (a.airTime || "99:99").localeCompare(b.airTime || "99:99") || a.title.localeCompare(b.title, "zh-CN")),
  ])), [schedules]);

  async function sync() {
    setBusy(true);
    setMessage("");
    setSyncProgress(0);
    const provider = source === "all" || source === "custom" ? "bangumi" : source;
    const providerLabel = sourceLabels[provider] || provider;
    setSyncStage(stageLabels.preparing);
    try {
      const result = await syncAiringSchedules({ season, year, source: provider }, (progress: AiringSyncProgress) => {
        setSyncProgress(progress.progress);
        setSyncStage(progress.stage === "requesting" ? `正在请求 ${providerLabel} 数据` : stageLabels[progress.stage] || progress.stage);
      });
      setSyncProgress(100);
      setSyncStage(stageLabels.complete);
      await load();
      setMessage(`${providerLabel} 同步完成：${result.count ?? result.synced} 条（新增 ${result.created}，更新 ${result.updated}）`);
    } catch (error) {
      setSyncStage("");
      setMessage(error instanceof Error ? error.message : "放送计划同步失败");
    } finally {
      setBusy(false);
    }
  }

  return <main className="airing-calendar-page">
    <header className="airing-calendar-header">
      <div>
        <button className="airing-back" onClick={() => router.push("/")}>← 返回月下集</button>
        <p>Asia/Tokyo · {year || "当前"} {season || "季度"}</p>
        <h1>番剧放送计划</h1>
        <span>本季度动画的播出时间、下一集和更新倒计时。</span>
      </div>
      <div className="airing-calendar-actions">
        <button className="airing-secondary" onClick={() => router.push("/settings/bangumi")}>Bangumi 设置</button>
        <button className="airing-primary" disabled={busy || source === "custom"} onClick={() => void sync()}>{busy ? "同步中…" : source === "custom" ? "自定义来源" : `同步${sourceLabels[source] || "放送数据"}`}</button>
      </div>
    </header>
    {busy && <div className="airing-sync-progress" role="status" aria-live="polite"><div className="airing-sync-progress-head"><b>{syncProgress}%</b><span>{syncStage || "同步中…"}</span></div><div className="airing-sync-track"><i style={{ width: syncProgress + "%" }} /></div></div>}
    {message && <p className="airing-message" role="status">{message}</p>}
    <div className="calendar-source-panel airing-source-panel"><div className="calendar-source-tabs" aria-label="放送数据来源">{Object.entries(sourceLabels).map(([id, label]) => <button key={id} className={source === id ? "active" : ""} disabled={busy} onClick={() => { setSource(id); void load(id).catch((error) => setMessage(error instanceof Error ? error.message : "无法读取放送来源")); }}>{label}</button>)}</div></div>
    <section className="calendar-body airing-calendar-body">
      <div className="calendar-day-title"><div><h3>本季放送日历</h3><p>{schedules.length ? "共 " + schedules.length + " 部动画 · 我的收藏优先显示" : "同步放送数据后显示本季度番剧"}</p></div><span>{sourceLabels[source] || source} · Asia/Tokyo</span></div>
      <div className="calendar-week-groups">
        {weekdays.map((weekday) => {
          const items = groups.get(weekday) || [];
          return <section className="calendar-week-group" key={weekday}>
            <header><h4>星期{formatWeekday(weekday)}</h4><span>{items.length} 部</span></header>
            <div>{items.length ? items.map((item) => <article className={item.isCollected ? "calendar-list-row followed" : "calendar-list-row"} key={item.id}>
              <CoverImage key={coverFor(item)} className="calendar-poster" src={coverFor(item)} alt={item.title + "封面"} placeholder={item.title.slice(0, 1)} />
              <div className="calendar-list-copy"><h4>{item.title}</h4><span className="source-tag">{item.source}</span>{item.jpTitle && <small className="calendar-jp-title">{item.jpTitle}</small>}<small>{(item.airTime || "播出时间待定") + (item.nextEpisode ? " · 下一集 " + item.nextEpisode : "") + (item.nextAirAt ? " · " + localDateTime(item.nextAirAt) : "")}</small><small>{item.nextAirAt ? formatAiringCountdown(item.nextAirAt, now) : "等待下一次更新时间"}</small></div>
              <span className="calendar-airing-status">{item.isCollected ? "我的收藏" : "放送计划"}</span>
            </article>) : <p className="calendar-group-empty">当天暂无更新</p>}</div>
          </section>;
        })}
      </div>
    </section>
  </main>;
}
