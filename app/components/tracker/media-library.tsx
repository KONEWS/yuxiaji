"use client";

import { useEffect, useMemo, useState } from "react";
import { highResCoverUrl } from "../../lib/client-api";
import { mediaMeta, mediaSettings, primaryStatusMeta, secondaryStatusMeta, week } from "../../lib/tracker-data";
import { type VideoSubtypeLabels, type VisualSubtypeLabels } from "../../lib/constants";
import { formatAiringCountdown, formatWeekday } from "../../lib/anime-airing-time";
import type { AiringSchedule, Anime, CalendarDay, CalendarEntry, LayoutMode, MediaTab, MediaType, SortMode, Status, WeekDay } from "../../lib/tracker-types";
import { CoverImage, Rating, RoundedSelect } from "./common";

function AnimeCard({ item, onAdjust, onDetails, onRate, titleMode, layout, visualSubtypeLabels, videoSubtypeLabels, airingBySubjectId }: { item: Anime; onAdjust: (id: number, delta: number) => void; onDetails: (id: number) => void; onRate: (id: number, score: number) => void; titleMode: string; layout: LayoutMode; visualSubtypeLabels: VisualSubtypeLabels; videoSubtypeLabels: VideoSubtypeLabels; airingBySubjectId?: Map<number, AiringSchedule> }) {
  const [now, setNow] = useState(() => Date.now());
  const percentage = Math.round((item.progress / Math.max(item.total, 1)) * 100);
  const displayTitle = titleMode === "jp" && item.jp ? item.jp : item.title;
  const mediaType = item.mediaType || "anime";
  const airing = mediaType === "anime" && item.subjectId ? airingBySubjectId?.get(item.subjectId) : undefined;
  const isVisual = mediaType === "visual";
  const isVideo = mediaType === "video";
  const cover = isVisual ? item.thumbnail || "" : item.image || (isVideo ? item.thumbnail || "" : mediaType === "anime" ? highResCoverUrl(item.jp || item.title) : "");
  const setting = mediaSettings[mediaType];
  const isMusic = mediaType === "music";
  const unit = item.unit || setting.unit;
  const rawSourceLabel = isVideo ? item.metadata?.videoSource || item.source || setting.sources : item.metadata?.provider === "tmdb" ? "TMDB" : item.source || setting.sources;
  const sourceLabel = rawSourceLabel.trim().toLowerCase() === "manual" ? "Custom" : rawSourceLabel;
  const statusLabel = isMusic ? { watching: "常听", wish: "想听", finished: "已收藏", library: "稍后", dropped: "移除" }[item.status] : { watching: "进行中", wish: "未开始", finished: "已完成", library: "搁置", dropped: "抛弃" }[item.status];
  const progressText = mediaType === "game" ? `${item.progress}%` : isVideo ? item.metadata?.duration || "视频收藏" : `${item.progress} / ${item.total} ${unit}`;
  const mediaLabel = mediaMeta.find(([id]) => id === mediaType)?.[1] || "动画";
  useEffect(() => {
    if (!airing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [airing]);
  if (layout === "list") return <article className="anime-list-row">
    <div className="anime-list-category"><span className={`media-badge media-${mediaType}`}>{mediaLabel}</span><small>{statusLabel}</small></div>
    <div className="anime-list-main"><div className="anime-list-title-line"><h3>{displayTitle}</h3><span className="anime-list-subtitle">{item.jp || item.source || "未记录来源"}</span>{item.tags.length > 0 && <span className="anime-list-tags">{item.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}</span>}</div>{airing && <div className="airing-card-meta"><span>下一集 {airing.nextEpisode ?? "待定"} · {airing.airTime ? `${formatWeekday(airing.weekday)} ${airing.airTime}` : airing.weekdayLabel}</span><small>{formatAiringCountdown(airing.nextAirAt, now)}</small></div>}</div>
    <div className="anime-list-score"><b>{item.score ? item.score.toFixed(1) : "—"}</b><small>个人评分</small></div>
    <div className="anime-list-progress">{isMusic ? <small>{item.musicArtist || "单曲"}</small> : isVisual ? <small>{item.visualSubtype ? visualSubtypeLabels[item.visualSubtype] : "视觉收藏"}</small> : isVideo ? <small>{item.videoSubtype ? videoSubtypeLabels[item.videoSubtype] : "视频收藏"}</small> : <><b>{progressText}</b><small>{percentage}%</small></>}</div>
    <div className="anime-list-actions">{!isMusic && !isVisual && !isVideo && <><button className="square" onClick={() => onAdjust(item.id, -setting.step)} aria-label="撤销上次进度">−</button><button className="record" onClick={() => onAdjust(item.id, setting.step)}>{setting.action}</button></>}<button className="text-button" onClick={() => onDetails(item.id)}>详情 <span>↗</span></button></div>
  </article>;
  return <article className="anime-card">
    <div className={`anime-poster poster-${item.kind} ${isVisual ? "gallery-poster" : ""}`}><CoverImage key={cover} className="anime-cover-image" src={cover} alt={`${item.title}封面`} placeholder={item.title.slice(0, 2)} /><span>{statusLabel}</span></div>
    <div className="anime-info">
      <div className="anime-title"><div><h3>{displayTitle}</h3><p><span className={`media-badge media-${mediaType}`}>{mediaMeta.find(([id]) => id === mediaType)?.[1]}</span>{sourceLabel} · 个人评分 {item.score ? item.score.toFixed(1) : "未评"}</p></div></div>
      {item.next && <div className="next-episode">{item.next}</div>}
      {airing && <div className="airing-card-meta"><span>下一集 {airing.nextEpisode ?? "待定"} · {airing.airTime ? `${formatWeekday(airing.weekday)} ${airing.airTime}` : airing.weekdayLabel}</span><small>{formatAiringCountdown(airing.nextAirAt, now)}</small></div>}
      {isMusic && <div className="music-card-meta"><b>{item.musicArtist || "歌手未记录"}</b><span>{item.musicAlbum ? `专辑 · ${item.musicAlbum}` : "单曲"}{item.lyricist ? ` · 作词 ${item.lyricist}` : ""}{item.composer ? ` · 作曲 ${item.composer}` : ""}</span>{item.animeSong && <em>动漫歌曲</em>}</div>}
      {isVisual && <div className="music-card-meta"><b>{item.visualSubtype ? visualSubtypeLabels[item.visualSubtype] : "视觉收藏"}</b><span>{item.author || "作者未记录"}{item.pixivPid ? ` · Pixiv ${item.pixivPid}` : ""}</span>{item.characterTags?.length ? <em>{item.characterTags.slice(0, 2).join(" · ")}</em> : null}</div>}
      {isVideo && <div className="music-card-meta"><b>{item.metadata?.platform || "平台未记录"}</b><span>{item.metadata?.creator || "创作者未记录"}{item.metadata?.duration ? ` · ${item.metadata.duration}` : ""}</span><em>{item.videoSubtype ? videoSubtypeLabels[item.videoSubtype] : "视频收藏"}</em></div>}
      <p className="anime-note">{item.note}</p><Rating score={item.score} onRate={(score) => onRate(item.id, score)} />
      {item.tags.length > 0 && <div className="anime-personal-tags">{item.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>}
      {!isMusic && !isVisual && !isVideo && <><div className="episode-line"><span><b>{progressText}</b></span><small>{percentage}%</small></div><div className="progress-track"><i style={{ width: `${percentage}%` }} /></div></>}
      <div className={`card-actions ${isMusic || isVisual || isVideo ? "music-actions" : ""}`}>{!isMusic && !isVisual && !isVideo && <><button className="square" onClick={() => onAdjust(item.id, -setting.step)} aria-label="撤销上次进度">−</button><button className="record" onClick={() => onAdjust(item.id, setting.step)}>{setting.action}</button></>}<button className="text-button" onClick={() => onDetails(item.id)}>详情 <span>↗</span></button></div>
    </div>
  </article>;
}

function CalendarPoster({ item }: { item: CalendarEntry }) {
  const src = item.coverUrl || highResCoverUrl(item.coverQuery);
  return <CoverImage key={src} className="calendar-poster" src={src} alt={`${item.title}封面`} placeholder={item.title.slice(0, 1)} />;
}

export function WeeklyCalendar({ open, toggle, titleMode, airingSchedules }: { open: (day: CalendarDay) => void; toggle: (item: CalendarEntry) => void; titleMode: string; airingSchedules?: AiringSchedule[] }) {
  const [activeDay, setActiveDay] = useState<WeekDay>("五");
  const liveEntries = airingSchedules?.map((item) => {
    const images = item.metadata?.images;
    const image = images && typeof images === "object" ? (images as Record<string, unknown>).large || (images as Record<string, unknown>).common || (images as Record<string, unknown>).medium : "";
    return { title: item.title, jp: item.jpTitle, subjectId: item.subjectId, coverQuery: item.jpTitle || item.title, coverUrl: typeof image === "string" ? image.replace(/^http:\/\//i, "https://") : undefined, meta: `${item.airTime || "时间待定"} · 下一集 ${item.nextEpisode ?? "待定"}`, followed: item.isCollected, source: item.source === "bangumi" ? "Bangumi" : item.source, day: formatWeekday(item.weekday) as WeekDay, long: false };
  }) || [];
  const sourceEntries = liveEntries;
  const mini = sourceEntries.filter((item) => item.day === activeDay).slice(0, 5);
  return <aside className="schedule-panel"><div className="schedule-title"><div><p>星期{activeDay}</p><h2>放送更新</h2></div><button onClick={() => open("all")}>查看全部 <span>→</span></button></div><div className="week-strip">{week.map((day) => <button key={day} className={day === activeDay ? "active" : ""} onClick={() => setActiveDay(day as WeekDay)} aria-pressed={day === activeDay}><b>{day}</b></button>)}</div><div className="schedule-list">{mini.map((item) => <div key={item.title} className={`schedule-row ${item.followed ? "current" : ""}`}><button className="schedule-open" onClick={() => open(activeDay)}><CalendarPoster item={item} /><span><b>{titleMode === "jp" ? item.jp : item.title}</b><small>{item.meta.split("·").slice(0, 2).join("·")}</small></span></button><button className="schedule-add" onClick={() => toggle(item)} aria-label={item.followed ? `取消追更${item.title}` : `追番${item.title}`} title={item.followed ? "再次点击取消追更" : "加入追更"}>{item.followed ? "✓" : "＋"}</button></div>)}</div></aside>;
}

type MediaLibraryProps = {
  anime: Anime[]; visibleAnime: Anime[]; collections: string[]; activeStatus: Status | "all"; setActiveStatus: (value: Status | "all") => void; statusCounts: Record<Status | "all", number>;
  activeMedia: MediaType | "all"; setActiveMedia: (value: MediaType | "all") => void; mediaOrder: MediaTab[]; mediaDragIndex: { current: number | null }; moveMediaTab: (index: number) => void;
  activeCollection: string; setActiveCollection: (value: string) => void; selectCollection: (value: string) => void;
  openCollectionManager: () => void;
  openAdd: () => void; openCollection: () => void; openVisualSubtypeManager: (returnTo?: "add" | "library") => void; acgLayout: LayoutMode; setAcgLayout: (value: LayoutMode) => void;
  ratingScope: "all" | "personal" | "global"; setRatingScope: (value: "all" | "personal" | "global") => void; scoreFloor: number; setScoreFloor: (value: number) => void; activeTag: string; setActiveTag: (value: string) => void; mediaTags: string[]; hideDropped: boolean; setHideDropped: (value: boolean) => void; sortMode: SortMode; setSortMode: (value: SortMode) => void;
  musicFacets: { albums: string[]; artists: string[]; lyricists: string[] }; musicAlbum: string; setMusicAlbum: (value: string) => void; musicArtist: string; setMusicArtist: (value: string) => void; musicLyricist: string; setMusicLyricist: (value: string) => void; animeSongsOnly: boolean; setAnimeSongsOnly: (value: boolean) => void; visualSubtype: string; setVisualSubtype: (value: string) => void; visualSubtypeLabels: VisualSubtypeLabels; videoSubtype: string; setVideoSubtype: (value: string) => void; videoSubtypeLabels: VideoSubtypeLabels; openVideoSubtypeManager: (returnTo?: "add" | "library") => void;
  onAdjust: (id: number, delta: number) => void; onDetails: (id: number) => void; onRate: (id: number, score: number) => void; titleMode: string; openCalendar: (day: CalendarDay) => void; toggleCalendarTracking: (item: CalendarEntry) => void; airingSchedules?: AiringSchedule[]; airingBySubjectId?: Map<number, AiringSchedule>;
};

export function MediaLibrary(props: MediaLibraryProps) {
  const [canDragMedia, setCanDragMedia] = useState(true);
  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 681px)");
    const update = () => setCanDragMedia(mediaQuery.matches);
    update();
    mediaQuery.addEventListener?.("change", update);
    return () => mediaQuery.removeEventListener?.("change", update);
  }, []);
  const orderedMediaMeta = useMemo(() => props.mediaOrder.map((id) => mediaMeta.find(([candidate]) => candidate === id)).filter((entry): entry is [MediaTab, string, string] => Boolean(entry)), [props.mediaOrder]);
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const scopedAnime = props.activeMedia === "all" ? props.anime : props.anime.filter((item) => (item.mediaType || "anime") === props.activeMedia);
    scopedAnime.forEach((item) => item.tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return props.mediaTags.map((tag) => ({ tag, count: counts.get(tag) || 0 })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
  }, [props.activeMedia, props.anime, props.mediaTags]);
  return <section className="content-grid"><div className="library-panel"><div className="section-title"><div><h2>收藏库</h2><p>{props.visibleAnime.length} 个条目 · {props.collections.length} 个合集</p></div><div className="section-title-actions"><div className="view-toggle" role="group" aria-label="收藏库显示方式"><button type="button" className={props.acgLayout === "grid" ? "active" : ""} onClick={() => props.setAcgLayout("grid")} aria-label="网格显示" aria-pressed={props.acgLayout === "grid"} title="网格显示">▦</button><button type="button" className={props.acgLayout === "list" ? "active" : ""} onClick={() => props.setAcgLayout("list")} aria-label="列表显示" aria-pressed={props.acgLayout === "list"} title="列表显示">☷</button></div><button className="mobile-add" onClick={props.openAdd}>＋</button></div></div>
    <div className="library-nav-row"><nav className="status-tabs">{primaryStatusMeta.map(([id, label]) => <button key={id} className={props.activeStatus === id ? "active" : ""} onClick={() => props.setActiveStatus(id)}>{label}<span>{props.statusCounts[id]}</span></button>)}</nav><div className="status-actions"><button className={props.activeStatus === "all" ? "all-status active" : "all-status"} onClick={() => props.setActiveStatus("all")}>全部 <span>{props.statusCounts.all}</span></button><RoundedSelect className="status-more" value={secondaryStatusMeta.some(([id]) => id === props.activeStatus) ? props.activeStatus : "more"} onChange={(value) => { if (value !== "more") props.setActiveStatus(value as Status); }} options={[{ value: "more", label: "更多" }, ...secondaryStatusMeta.map(([id, label]) => ({ value: id, label: `${label} ${props.statusCounts[id]}` }))]} ariaLabel="更多状态" /></div></div>
    <div className="collection-controls"><div className="media-tabs" aria-label="媒体分类">{orderedMediaMeta.map(([id, label, icon], index) => <button key={id} draggable={canDragMedia && id !== "all"} onDragStart={() => { if (canDragMedia && id !== "all") props.mediaDragIndex.current = index; }} onDragEnd={() => { props.mediaDragIndex.current = null; }} onDragOver={(event) => { if (canDragMedia && id !== "all") event.preventDefault(); }} onDrop={() => { if (canDragMedia && id !== "all") props.moveMediaTab(index); }} title={id === "all" ? "全部媒体" : canDragMedia ? "拖动排序" : label} className={props.activeMedia === id ? "active" : ""} onClick={() => props.setActiveMedia(id)}><i>{icon}</i>{label}</button>)}</div><div className="library-tools"><button className="new-collection" onClick={props.openCollection}>＋ 新建合集</button><button className="collection-menu-button" onClick={props.openCollectionManager} aria-label="管理合集" title="管理合集">☰</button></div></div>
    {props.collections.length > 0 && <nav className="collection-chips collection-row" aria-label="合集">{props.collections.map((name) => <button key={name} className={props.activeCollection === name ? "active" : ""} onClick={() => props.selectCollection(name)}>{name}</button>)}</nav>}
    <section className="tag-library" aria-label="个人标签"><div className="tag-library-title"><i>◇</i><h3>标签</h3></div><div className="tag-library-chips"><button className={props.activeTag === "all" ? "active" : ""} onClick={() => props.setActiveTag("all")}>全部标签</button>{tagCounts.map(({ tag, count }) => <button key={tag} className={props.activeTag === tag ? "active" : ""} onClick={() => props.setActiveTag(tag)}>#{tag} <span>({count})</span></button>)}</div></section>
    <div className="sort-filter-bar"><div><RoundedSelect value={props.ratingScope} onChange={props.setRatingScope} options={[{ value: "personal", label: "个人评分" }, { value: "global", label: "Bangumi 评分" }, { value: "all", label: "两者较高" }]} ariaLabel="评分类型" /><RoundedSelect value={props.scoreFloor} onChange={props.setScoreFloor} options={[{ value: 0, label: "不限分数" }, { value: 6, label: "6 分以上" }, { value: 7, label: "7 分以上" }, { value: 8, label: "8 分以上" }, { value: 9, label: "9 分以上" }]} ariaLabel="最低评分" />{props.activeStatus === "all" && <label className={props.hideDropped ? "active" : ""}><input type="checkbox" checked={props.hideDropped} onChange={(event) => props.setHideDropped(event.target.checked)} />隐藏抛弃</label>}</div><RoundedSelect className="sort-select" value={props.sortMode} onChange={props.setSortMode} options={[{ value: "updated", label: "最近记录" }, { value: "personal", label: "个人评分从高到低" }, { value: "global", label: "Bangumi 评分从高到低" }, { value: "progress", label: "进度从高到低" }, { value: "title", label: "标题排序" }]} ariaLabel="排序方式" /></div>
    {props.activeMedia === "music" && <div className="music-filter-bar"><RoundedSelect value={props.musicAlbum} onChange={props.setMusicAlbum} options={[{ value: "all", label: "全部专辑" }, ...props.musicFacets.albums.map((album) => ({ value: album, label: album }))]} ariaLabel="按专辑筛选" /><RoundedSelect value={props.musicArtist} onChange={props.setMusicArtist} options={[{ value: "all", label: "全部歌手" }, ...props.musicFacets.artists.map((artist) => ({ value: artist, label: artist }))]} ariaLabel="按歌手筛选" /><RoundedSelect value={props.musicLyricist} onChange={props.setMusicLyricist} options={[{ value: "all", label: "全部作词" }, ...props.musicFacets.lyricists.map((lyricist) => ({ value: lyricist, label: lyricist }))]} ariaLabel="按作词筛选" /><label className={props.animeSongsOnly ? "active" : ""}><input type="checkbox" checked={props.animeSongsOnly} onChange={(event) => props.setAnimeSongsOnly(event.target.checked)} />动漫歌曲</label></div>}
    {props.activeMedia === "visual" && <div className="music-filter-bar"><RoundedSelect value={props.visualSubtype} onChange={props.setVisualSubtype} options={[{ value: "all", label: "全部" }, ...Object.entries(props.visualSubtypeLabels).map(([id, label]) => ({ value: id, label }))]} ariaLabel="按画廊子类型筛选" /><button type="button" className="inline-manage-button" onClick={() => props.openVisualSubtypeManager("library")}>管理子类型</button></div>}
    {props.activeMedia === "video" && <div className="music-filter-bar"><RoundedSelect value={props.videoSubtype} onChange={props.setVideoSubtype} options={[{ value: "all", label: "全部" }, ...Object.entries(props.videoSubtypeLabels).map(([id, label]) => ({ value: id, label }))]} ariaLabel="按视频子分类筛选" /><button type="button" className="inline-manage-button" onClick={() => props.openVideoSubtypeManager("library")}>管理子类型</button></div>}
    <div className={`anime-grid ${props.acgLayout === "list" ? "anime-grid-list" : ""}`}>{props.acgLayout === "list" && <div className="anime-list-header"><span>分类</span><span>作品名</span><span>评分</span><span>进度</span><span>操作</span></div>}{props.visibleAnime.map((item) => <AnimeCard key={item.id} item={item} layout={props.acgLayout} onAdjust={props.onAdjust} onDetails={props.onDetails} onRate={props.onRate} titleMode={props.titleMode} visualSubtypeLabels={props.visualSubtypeLabels} videoSubtypeLabels={props.videoSubtypeLabels} airingBySubjectId={props.airingBySubjectId} />)}{!props.visibleAnime.length && <div className="empty-state"><b>这里暂时没有收藏</b><p>可以调整筛选条件，或者添加一个新条目。</p><button onClick={props.openAdd}>添加收藏</button></div>}</div></div><WeeklyCalendar open={props.openCalendar} toggle={props.toggleCalendarTracking} titleMode={props.titleMode} airingSchedules={props.airingSchedules} /></section>;
}
