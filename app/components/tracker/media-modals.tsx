"use client";

import { useEffect, useRef, useState } from "react";
import { fetchSubjectDetail, highResCoverUrl, loadAiringSchedules, removeCustomAiring, saveCustomAiring, syncAiringSchedules } from "../../lib/client-api";
import { normalizeMediaSource } from "../../lib/media-source";
import { mediaMeta, mediaSettings, seedAnime, splitTags, week } from "../../lib/tracker-data";
import { normalizeMediaMetadata, normalizeVideoSubtype, normalizeVisualSubtype, type VideoSubtypeLabels, type VisualSubtypeLabels } from "../../lib/constants";
import type { AddForm, AiringSchedule, Anime, BangumiDetail, CalendarDay, CalendarEntry, MediaType, SearchResult, WeekDay } from "../../lib/tracker-types";
import { RoundedSelect } from "./common";
import { CoverImage, Rating } from "./common";

function CalendarPoster({ item }: { item: CalendarEntry }) {
  const src = item.coverUrl || highResCoverUrl(item.coverQuery);
  return <CoverImage key={src} className="calendar-poster" src={src} alt={`${item.title}封面`} placeholder={item.title.slice(0, 1)} />;
}

function CoverField({ value, label, placeholder, previewAlt, inputId, uploading, onChange, onUpload }: {
  value: string;
  label: string;
  placeholder: string;
  previewAlt: string;
  inputId: string;
  uploading: boolean;
  onChange: (value: string) => void;
  onUpload: (file?: File) => void | Promise<void>;
}) {
  return <label className="wide detail-image-field">{label}<input type="url" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /><div className="detail-image-upload"><span className="file-picker"><input id={inputId} className="file-picker-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; void onUpload(file); }} disabled={uploading} /><button type="button" className="file-picker-button" onClick={() => document.getElementById(inputId)?.click()} disabled={uploading}>{uploading ? "上传中…" : "上传封面"}</button><small>{value ? "已选择图片" : "未选择文件"}</small></span>{value && <span className="cover-preview"><img src={value} alt={previewAlt} referrerPolicy="no-referrer" /><b>已选择图片</b></span>}</div></label>;
}

function AddModal({ query, setQuery, search, searching, results, choose, form, setForm, collections, close, submit, uploadImage, thumbnailUploading, visualSubtypeLabels, openVisualSubtypeManager, videoSubtypeLabels, openVideoSubtypeManager }: {
  query: string; setQuery: (value: string) => void; searching: boolean; results: SearchResult[];
  choose: (result: SearchResult) => void | Promise<void>; form: AddForm;
  setForm: React.Dispatch<React.SetStateAction<AddForm>>;
  collections: string[]; search: () => void; close: () => void; submit: () => void; uploadImage: (file?: File) => Promise<string | null>; thumbnailUploading: boolean; visualSubtypeLabels: VisualSubtypeLabels; openVisualSubtypeManager: (returnTo?: "add" | "library") => void; videoSubtypeLabels: VideoSubtypeLabels; openVideoSubtypeManager: (returnTo?: "add" | "library") => void;
}) {
  const setting = mediaSettings[form.mediaType];
  const canSearchRemote = ["anime", "game", "light_novel", "manga", "music", "movie", "tv"].includes(form.mediaType);
  const isMusic = form.mediaType === "music";
  const isVisual = form.mediaType === "visual";
  const isVideo = form.mediaType === "video";
  const isFilm = form.mediaType === "movie" || form.mediaType === "tv";
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card add-modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
    <div className="modal-title"><div><p>添加到月下集</p><h2 id="add-title">新的收藏</h2></div><button onClick={close} aria-label="关闭">×</button></div>
    <div className="media-type-picker">{mediaMeta.filter(([id]) => id !== "all").map(([id, label, icon]) => <button key={id} className={form.mediaType === id ? "active" : ""} onClick={() => { const nextType = id as MediaType; const nextFilm = nextType === "movie" || nextType === "tv"; setForm({ ...form, mediaType: nextType, total: nextType === "game" ? 100 : nextType === "movie" || nextType === "music" || nextType === "video" ? 1 : form.total === 100 ? 12 : form.total, subjectId: undefined, image: "", thumbnail: nextType === "visual" || nextType === "video" ? "" : form.thumbnail, globalScore: nextFilm ? form.globalScore : undefined, metadata: nextFilm || nextType === "video" ? form.metadata : normalizeMediaMetadata() }); setQuery(""); }}><i>{icon}</i>{label}</button>)}</div>
    <div className="source-suggestion"><span>推荐数据源</span><b>{setting.sources}</b></div>
    {canSearchRemote && <><label>搜索 {isFilm ? "TMDB" : "Bangumi"} 全库</label>
    <div className="add-search"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search(); } }} placeholder="输入中文名、原名或关键词" /><button type="button" onClick={search}>搜索</button></div>
      <p className="search-help">{isFilm ? "电影和电视剧通过 TMDB 获取海报、简介、评分与演职员信息。" : "动画、游戏、书籍、漫画和 ACG 音乐均可搜索 Bangumi；也可以手动录入并保存在月下集。"}</p></>}
     {isFilm && <p className="search-help">影视条目由月下集手动记录，以下信息会保存在扩展元数据中。</p>}
    {isVisual && <p className="search-help">画廊只保存缩略图和元数据，不保存原图；原始图片最大 20 MB，浏览器会压缩为不超过 5 MB 的缩略图。</p>}
    {isVideo && <p className="search-help">视频只保存标题、图片地址和元数据，不上传视频文件、不提供在线播放。</p>}
    {(searching || results.length > 0) && <div className="lookup-results">{searching ? <p>搜索中…</p> : results.slice(0, 6).map((result) => <button className="search-result" key={result.id} onClick={() => { void choose(result); }}>{result.image ? <img src={result.image} alt="" referrerPolicy="no-referrer" /> : <i>无图</i>}<span><b>{result.title}</b><small>{result.jp}{result.date ? ` · ${result.date.slice(0, 4)}年` : ""}</small></span><em>选择</em></button>)}</div>}
    <div className="form-divider"><span>也可以手动填写</span></div>
    <div className="form-grid">
      <label className="wide">{isMusic ? "单曲名称" : "收藏名称"}<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder={isMusic ? "例如：晴る" : "作品名称"} /></label>
      <label className="wide">原名 / 外文名<input value={form.jp} onChange={(event) => setForm({ ...form, jp: event.target.value })} placeholder="可选" /></label>
      {!isMusic && !isVisual && <label>总进度（{setting.unit}）<input type="number" min="1" max={form.mediaType === "game" ? 100 : undefined} value={form.total} onChange={(event) => setForm({ ...form, total: Number(event.target.value) })} /></label>}
      <label>状态<RoundedSelect value={form.status} onChange={(value) => setForm({ ...form, status: value })} options={[{ value: "watching", label: "进行中" }, { value: "wish", label: "未开始 / 未开播" }, { value: "finished", label: "已完成" }, { value: "library", label: "搁置" }, { value: "dropped", label: "抛弃" }]} ariaLabel="状态" /></label>
       <label className="wide">所属合集<RoundedSelect value={form.collection} onChange={(value) => setForm({ ...form, collection: value })} options={[{ value: "", label: "不加入合集" }, ...collections.map((name) => ({ value: name, label: name }))]} ariaLabel="所属合集" /></label>
      {isFilm && <><label>导演<input value={form.metadata.director} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, director: event.target.value } })} /></label><label>演员<input value={form.metadata.actors.join("，")} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, actors: event.target.value.split(/[,，、\s]+/).map((actor) => actor.trim()).filter(Boolean) } })} placeholder="用逗号分隔" /></label><label>年份<input type="number" min="1800" max="3000" value={form.metadata.year || ""} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, year: Number(event.target.value) || undefined } })} /></label><label>地区<input value={form.metadata.region} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, region: event.target.value } })} /></label><label>季数<input type="number" min="1" max="100" value={form.metadata.seasons || ""} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, seasons: Number(event.target.value) || undefined } })} /></label><label>集数<input type="number" min="1" max="10000" value={form.metadata.episodes || ""} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, episodes: Number(event.target.value) || undefined } })} /></label><label className="wide">标签<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="用逗号分隔，例如：科幻，悬疑，漫改" /></label></>}
      {isMusic && <><label>专辑<input value={form.musicAlbum} onChange={(event) => setForm({ ...form, musicAlbum: event.target.value })} placeholder="单曲所属专辑" /></label><label>歌手<input value={form.musicArtist} onChange={(event) => setForm({ ...form, musicArtist: event.target.value })} placeholder="演唱者" /></label><label>作词<input value={form.lyricist} onChange={(event) => setForm({ ...form, lyricist: event.target.value })} placeholder="作词人" /></label><label>作曲<input value={form.composer} onChange={(event) => setForm({ ...form, composer: event.target.value })} placeholder="作曲人" /></label><label className="wide">来源信息<input value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} placeholder="例如：个人录入、实体唱片" /></label><label className="check-field"><input type="checkbox" checked={form.animeSong} onChange={(event) => setForm({ ...form, animeSong: event.target.checked })} />动漫歌曲</label></>}
      {isVideo && <><label>封面图片<input type="url" value={form.image} onChange={(event) => setForm({ ...form, image: event.target.value })} placeholder="粘贴封面图片地址" /></label><label>缩略图<input type="url" value={form.thumbnail} onChange={(event) => setForm({ ...form, thumbnail: event.target.value })} placeholder="粘贴缩略图地址（可选）" /></label><label>来源信息<input value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} placeholder="例如：YouTube、个人收藏" /></label><label>来源链接<input type="url" value={form.sourceUrl} onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })} placeholder="视频页面或原始来源链接" /></label><label>平台<input value={form.metadata.platform || ""} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, platform: event.target.value } })} placeholder="例如：YouTube、Bilibili" /></label><label>创作者<input value={form.metadata.creator || ""} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, creator: event.target.value } })} placeholder="作者或频道" /></label><label>时长<input value={form.metadata.duration || ""} onChange={(event) => setForm({ ...form, metadata: { ...form.metadata, duration: event.target.value } })} placeholder="例如：03:42" /></label><label>视频子分类<div className="inline-field"><RoundedSelect value={form.videoSubtype} onChange={(value) => setForm({ ...form, videoSubtype: normalizeVideoSubtype(value) })} options={Object.entries(videoSubtypeLabels).map(([id, label]) => ({ value: id, label }))} ariaLabel="视频子分类" /><button type="button" className="inline-manage-button" onClick={() => openVideoSubtypeManager("add")}>管理</button></div></label><label className="wide">标签<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="用逗号分隔，例如：MAD，角色，现场" /></label></>}
      {isVisual ? <><CoverField value={form.thumbnail} label="缩略图地址（仅保存缩略图）" placeholder="粘贴缩略图地址，不上传原图" previewAlt="缩略图预览" inputId="add-media-cover-input" uploading={thumbnailUploading} onChange={(value) => setForm((current) => ({ ...current, thumbnail: value }))} onUpload={async (file) => { const url = await uploadImage(file); if (url) setForm((current) => ({ ...current, thumbnail: url })); }} /><label>画廊子类型<div className="inline-field"><RoundedSelect value={form.visualSubtype} onChange={(value) => setForm({ ...form, visualSubtype: normalizeVisualSubtype(value) })} options={Object.entries(visualSubtypeLabels).map(([id, label]) => ({ value: id, label }))} ariaLabel="画廊子类型" /><button type="button" className="inline-manage-button" onClick={() => openVisualSubtypeManager("add")}>管理</button></div></label><label>作者<input value={form.author} onChange={(event) => setForm({ ...form, author: event.target.value })} placeholder="作者名" /></label><label>Pixiv PID<input value={form.pixivPid} onChange={(event) => setForm({ ...form, pixivPid: event.target.value })} placeholder="可选" /></label><label>Twitter / X 来源<input value={form.twitterSource} onChange={(event) => setForm({ ...form, twitterSource: event.target.value })} placeholder="可选链接" /></label><label className="wide">来源链接<input type="url" value={form.sourceUrl} onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })} placeholder="Pixiv、个人站点或其他来源" /></label><label className="wide">标签<input value={form.characterTags} onChange={(event) => setForm({ ...form, characterTags: event.target.value })} placeholder="用逗号分隔，例如：星野爱，初音未来" /></label></> : !isVideo && <CoverField value={form.image} label="封面图片" placeholder="搜索选择后会自动填入，也可粘贴图片地址" previewAlt="封面预览" inputId="add-media-cover-input" uploading={thumbnailUploading} onChange={(value) => setForm((current) => ({ ...current, image: value }))} onUpload={async (file) => { const url = await uploadImage(file); if (url) setForm((current) => ({ ...current, image: url })); }} />}
      <label className="wide">{isVideo ? "简介" : "备注"}<textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder={isVideo ? "视频描述" : "观看理由、角色或片段…"} /></label>
    </div>
    <div className="submit-row"><button onClick={close}>取消</button><button className="primary-button" onClick={submit}>加入月下集</button></div>
  </section></div>;
}

function VisualSubtypeModal({ labels, close, save }: { labels: VisualSubtypeLabels; close: () => void; save: (labels: VisualSubtypeLabels) => void }) {
  const [draft, setDraft] = useState<VisualSubtypeLabels>(() => ({ ...labels }));
  const [newName, setNewName] = useState("");
  const dragIndex = useRef<number | null>(null);
  const ids = Object.keys(draft);
  const move = (targetIndex: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === targetIndex) return;
    setDraft((current) => {
      const order = Object.keys(current);
      const [moved] = order.splice(from, 1);
      if (moved) order.splice(targetIndex, 0, moved);
      return Object.fromEntries(order.map((id) => [id, current[id]]));
    });
  };
  const add = () => {
    const label = newName.trim().slice(0, 30);
    if (!label) return;
    const id = `custom_${Date.now().toString(36)}`;
    setDraft((current) => ({ ...current, [id]: label }));
    setNewName("");
  };
  const remove = (id: string) => {
    if (id === "other" || ids.length <= 1) return;
    setDraft((current) => { const next = { ...current }; delete next[id]; return next; });
  };
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card subcategory-modal" role="dialog" aria-modal="true" aria-labelledby="visual-subtype-title"><div className="modal-title"><div><p>画廊</p><h2 id="visual-subtype-title">管理画廊子类型</h2></div><button onClick={close} aria-label="关闭">×</button></div><p className="manager-hint">拖动排序、修改名称或删除子类型；“其他”作为默认兜底分类保留。</p><div className="subcategory-sort-list">{ids.map((id, index) => <div key={id} className="visual-subtype-editor" draggable onDragStart={() => { dragIndex.current = index; }} onDragEnd={() => { dragIndex.current = null; }} onDragOver={(event) => event.preventDefault()} onDrop={() => move(index)}><span aria-hidden="true">☰</span><input value={draft[id]} onChange={(event) => setDraft((current) => ({ ...current, [id]: event.target.value }))} maxLength={30} aria-label={`${draft[id]}名称`} /><small>拖动排序</small><button type="button" className="manager-delete-button" onClick={() => remove(id)} disabled={id === "other"} aria-label={`删除${draft[id]}`} title={id === "other" ? "默认分类不可删除" : "删除子类型"}>×</button></div>)}</div><div className="subcategory-add"><input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} placeholder="新子类型名称" /><button type="button" onClick={add}>＋ 添加</button></div><div className="submit-row"><button onClick={close}>取消</button><button className="primary-button" onClick={() => save(draft)}>保存修改</button></div></section></div>;
}

function VideoSubtypeModal({ labels, close, save }: { labels: VideoSubtypeLabels; close: () => void; save: (labels: VideoSubtypeLabels) => void }) {
  const [draft, setDraft] = useState<VideoSubtypeLabels>(() => ({ ...labels }));
  const [newName, setNewName] = useState("");
  const dragIndex = useRef<number | null>(null);
  const ids = Object.keys(draft);
  const move = (targetIndex: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === targetIndex) return;
    setDraft((current) => {
      const order = Object.keys(current);
      const [moved] = order.splice(from, 1);
      if (moved) order.splice(targetIndex, 0, moved);
      return Object.fromEntries(order.map((id) => [id, current[id]]));
    });
  };
  const add = () => {
    const label = newName.trim().slice(0, 30);
    if (!label) return;
    const id = `custom_${Date.now().toString(36)}`;
    setDraft((current) => ({ ...current, [id]: label }));
    setNewName("");
  };
  const remove = (id: string) => {
    if (id === "other" || ids.length <= 1) return;
    setDraft((current) => { const next = { ...current }; delete next[id]; return next; });
  };
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card subcategory-modal" role="dialog" aria-modal="true" aria-labelledby="video-subtype-title"><div className="modal-title"><div><p>视频</p><h2 id="video-subtype-title">管理视频子分类</h2></div><button onClick={close} aria-label="关闭">×</button></div><p className="manager-hint">拖动排序、修改名称或删除视频子分类；“其他”作为默认兜底分类保留。</p><div className="subcategory-sort-list">{ids.map((id, index) => <div key={id} className="visual-subtype-editor" draggable onDragStart={() => { dragIndex.current = index; }} onDragEnd={() => { dragIndex.current = null; }} onDragOver={(event) => event.preventDefault()} onDrop={() => move(index)}><span aria-hidden="true">☰</span><input value={draft[id]} onChange={(event) => setDraft((current) => ({ ...current, [id]: event.target.value }))} maxLength={30} aria-label={`${draft[id]}名称`} /><small>拖动排序</small><button type="button" className="manager-delete-button" onClick={() => remove(id)} disabled={id === "other"} aria-label={`删除${draft[id]}`} title={id === "other" ? "默认分类不可删除" : "删除子分类"}>×</button></div>)}</div><div className="subcategory-add"><input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} placeholder="新子分类名称" /><button type="button" onClick={add}>＋ 添加</button></div><div className="submit-row"><button onClick={close}>取消</button><button className="primary-button" onClick={() => save(draft)}>保存修改</button></div></section></div>;
}

function CollectionModal({ name, setName, close, submit }: { name: string; setName: (value: string) => void; close: () => void; submit: () => void }) {
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card collection-modal" role="dialog" aria-modal="true" aria-labelledby="collection-title">
    <div className="modal-title"><div><p>自由整理收藏</p><h2 id="collection-title">新建合集</h2></div><button onClick={close} aria-label="关闭">×</button></div>
    <label>合集名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} placeholder="例如：雨天想看的作品" /></label>
    <p>合集可以混合动画、游戏、书与音乐，之后可在收藏库里单独筛选。</p>
    <div className="submit-row"><button onClick={close}>取消</button><button className="primary-button" onClick={submit}>创建合集</button></div>
  </section></div>;
}

function CollectionManagerModal({ collections, close, save }: { collections: string[]; close: () => void; save: (collections: string[]) => void }) {
  const [draft, setDraft] = useState(() => [...collections]);
  const dragIndex = useRef<number | null>(null);
  const move = (targetIndex: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === targetIndex) return;
    setDraft((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(targetIndex, 0, moved);
      return next;
    });
  };
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card subcategory-modal collection-manager-modal" role="dialog" aria-modal="true" aria-labelledby="collection-manager-title">
    <div className="modal-title"><div><p>收藏库</p><h2 id="collection-manager-title">管理合集</h2></div><button onClick={close} aria-label="关闭">×</button></div>
    <p className="manager-hint">拖动调整合集顺序，使用删除按钮移除合集。合集中的作品会回到全部媒体。</p>
    <div className="subcategory-sort-list collection-sort-list">{draft.length ? draft.map((name, index) => <div key={name} draggable onDragStart={() => { dragIndex.current = index; }} onDragEnd={() => { dragIndex.current = null; }} onDragOver={(event) => event.preventDefault()} onDrop={() => move(index)}><span aria-hidden="true">☰</span><b>{name}</b><small>拖动排序</small><button type="button" className="manager-delete-button" onClick={() => setDraft((current) => current.filter((item) => item !== name))} aria-label={`删除合集${name}`} title="删除合集">×</button></div>) : <p className="manager-empty">还没有自定义合集</p>}</div>
    <div className="submit-row"><button onClick={close}>取消</button><button className="primary-button" onClick={() => save(draft)}>保存修改</button></div>
  </section></div>;
}

function DetailDrawer({ item, collections, close, save, remove, uploadImage, imageUploading, visualSubtypeLabels, videoSubtypeLabels }: { item?: Anime; collections: string[]; close: () => void; save: (item: Anime) => void; remove: (id: number) => void; uploadImage: (file?: File) => Promise<string | null>; imageUploading: boolean; visualSubtypeLabels?: VisualSubtypeLabels; videoSubtypeLabels?: VideoSubtypeLabels }) {
  const [draft, setDraft] = useState<Anime>(() => item || seedAnime[0]);
  const [tagText, setTagText] = useState(() => (item?.tags || []).join("，"));
  const [bangumi, setBangumi] = useState<BangumiDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(() => Boolean(item && !["movie", "tv", "visual", "video"].includes(item.mediaType || "")));
  useEffect(() => {
    if (!item) return;
    let active = true;
    if (["movie", "tv", "visual", "video"].includes(item.mediaType || "")) return () => { active = false; };
    fetchSubjectDetail<BangumiDetail>(item.subjectId, item.title, item.mediaType || "anime")
      .then((detail) => { if (active) setBangumi(detail); })
      .catch(() => { if (active) setBangumi(null); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [item]);
  if (!item) return null;
  const mediaType = draft.mediaType || "anime";
  const setting = mediaSettings[mediaType];
  const isMusic = mediaType === "music";
  const isVisual = mediaType === "visual";
  const isVideo = mediaType === "video";
  const isMovie = mediaType === "movie";
  const isFilm = mediaType === "movie" || mediaType === "tv";
  const cover = draft.image || (isVideo ? draft.thumbnail || "" : mediaType === "anime" ? highResCoverUrl(draft.jp || draft.title) : "");
  const visualCover = draft.thumbnail || "";
  const imageValue = isVisual ? visualCover : draft.image || "";
  const detailSubjectId = draft.subjectId || bangumi?.id;
  const summaryOverride = draft.metadata?.overviewOverride === true;
  const summaryValue = summaryOverride
    ? draft.metadata?.overview || ""
    : draft.metadata?.overview || bangumi?.summary || draft.note || "";
  const summaryPending = detailLoading && Boolean(detailSubjectId) && !summaryOverride && !draft.metadata?.overview;
  const setImageValue = (value: string) => setDraft((current) => isVisual ? { ...current, thumbnail: value } : { ...current, image: value });
  const chooseImage = async (file?: File) => {
    if (!file) return;
    const url = await uploadImage(file);
    if (url) setImageValue(url);
  };
  const submit = () => {
    const total = isMusic || isVisual || isMovie || isVideo ? 1 : Math.max(1, Number(draft.total) || 1);
    const progress = isMusic || isVisual || isMovie || isVideo ? 0 : Math.min(Math.max(0, Number(draft.progress) || 0), total);
    const metadata = normalizeMediaMetadata({ ...draft.metadata, videoSource: isVideo ? draft.metadata?.videoSource || draft.source || "" : draft.metadata?.videoSource });
    save({ ...draft, image: isVisual ? undefined : draft.image, subjectId: isVisual || mediaType === "movie" || mediaType === "tv" || isVideo ? undefined : detailSubjectId, source: isVideo ? "manual" : normalizeMediaSource(draft.source, isVisual || mediaType === "movie" || mediaType === "tv" ? "manual" : detailSubjectId ? "bangumi" : "manual"), videoSubtype: isVideo ? normalizeVideoSubtype(draft.videoSubtype) : "other", metadata, tags: splitTags(tagText), characterTags: draft.characterTags || [], progress, status: draft.status === "wish" && progress > 0 ? "watching" : draft.status, total, updatedAt: Date.now() });
  };
  return <div className="overlay detail-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title">
    <header><h2 id="detail-title">收藏详情</h2><button onClick={close} aria-label="关闭详情">×</button></header>
    <div className="detail-content">
      <section className="detail-hero">
        <CoverImage key={isVisual ? visualCover : cover} className="detail-cover" src={isVisual ? visualCover : cover} alt={`${draft.title}封面`} placeholder={draft.title.slice(0, 2)} />
        <div><span className="detail-status">{isMusic ? { watching: "常听", wish: "想听", finished: "已收藏", library: "稍后", dropped: "移除" }[draft.status] : { watching: "进行中", wish: "未开始", finished: "已完成", library: "搁置", dropped: "抛弃" }[draft.status]}</span><span className={`detail-media media-${mediaType}`}>{mediaMeta.find(([id]) => id === mediaType)?.[1]}</span><h3>{draft.title}</h3>{draft.jp && <p>{draft.jp}</p>}{draft.next && <div className="detail-next"><b>{draft.next}</b><small>更新提醒已开启</small></div>}</div>
      </section>
      <section className="detail-personal-rating"><div><b>个人评分</b><span>你的收藏优先显示这一项</span></div><Rating score={draft.score} onRate={(score) => setDraft({ ...draft, score })} /></section>
      <div className="detail-divider" />
      <section className="detail-bangumi">
        <div className="detail-bangumi-head"><div><span>{isVisual ? "月下集画廊" : isVideo ? "月下集视频" : isFilm ? "TMDB" : `${draft.source || setting.sources} / Bangumi`}</span>{!isVisual && !isVideo && (detailLoading && detailSubjectId ? <b>读取中…</b> : bangumi?.score ? <b>{bangumi.score.toFixed(1)}<small> / 10</small></b> : draft.globalScore ? <b>{draft.globalScore.toFixed(1)}<small> / 10</small></b> : <b>暂无评分</b>)}</div>{bangumi && !isVisual && !isVideo && <p>{isFilm ? [bangumi.date, bangumi.platform, bangumi.metadata?.region, bangumi.metadata?.runtime ? `${bangumi.metadata.runtime} 分钟` : ""].filter(Boolean).join(" · ") : <>{bangumi.ratingTotal.toLocaleString()} 人评分{bangumi.rank ? ` · 排名 #${bangumi.rank}` : ""}<br />{[bangumi.date, bangumi.platform, bangumi.total && !isMusic ? `${bangumi.total} ${setting.unit}` : ""].filter(Boolean).join(" · ")}</>}</p>}</div>
        <div className="detail-summary"><b>作品简介</b><p>{summaryPending ? "正在读取详细资料…" : summaryValue || "暂时没有可用简介。"}</p></div>
        {bangumi?.tags.length ? <div className="detail-tags"><small>{isFilm ? "TMDB 类型" : "Bangumi 标签"}</small>{bangumi.tags.slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
      </section>
      <div className="detail-divider" />
      <section className="detail-form">
        <label className="wide">中文标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="wide">原名 / 外文名<input value={draft.jp} onChange={(event) => setDraft({ ...draft, jp: event.target.value })} /></label>
        <label>媒体类型<RoundedSelect value={mediaType} onChange={(next) => setDraft({ ...draft, mediaType: next, unit: mediaSettings[next].unit, source: next === "movie" || next === "tv" ? "manual" : draft.subjectId ? "bangumi" : "manual" })} options={mediaMeta.filter(([id]) => id !== "all").map(([id, label]) => ({ value: id as MediaType, label }))} ariaLabel="媒体类型" /></label>
        <label>状态<RoundedSelect value={draft.status} onChange={(value) => setDraft({ ...draft, status: value })} options={[{ value: "watching", label: "进行中" }, { value: "wish", label: "未开始" }, { value: "finished", label: "已完成" }, { value: "library", label: "搁置" }, { value: "dropped", label: "抛弃" }]} ariaLabel="状态" /></label>
        {!isMusic && !isVisual && !isMovie && !isVideo && <><label>当前进度（{setting.unit}）<input type="number" min="0" max={draft.total} value={draft.progress} onChange={(event) => setDraft({ ...draft, progress: Number(event.target.value) })} /></label><label>总进度（{setting.unit}）<input type="number" min="1" value={draft.total} onChange={(event) => setDraft({ ...draft, total: Number(event.target.value) })} /></label></>}
        {(mediaType === "movie" || mediaType === "tv") && <><label>导演<input value={draft.metadata?.director || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, director: event.target.value }) })} /></label><label>演员<input value={(draft.metadata?.actors || []).join("，")} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, actors: event.target.value }) })} placeholder="用逗号分隔" /></label><label>年份<input type="number" min="1800" max="3000" value={draft.metadata?.year || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, year: Number(event.target.value) || undefined }) })} /></label><label>地区<input value={draft.metadata?.region || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, region: event.target.value }) })} /></label><label>季数<input type="number" min="1" max="100" value={draft.metadata?.seasons || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, seasons: Number(event.target.value) || undefined }) })} /></label><label>集数<input type="number" min="1" max="10000" value={draft.metadata?.episodes || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, episodes: Number(event.target.value) || undefined }) })} /></label></>}
        {isMusic && <><label>专辑<input value={draft.musicAlbum || ""} onChange={(event) => setDraft({ ...draft, musicAlbum: event.target.value })} /></label><label>歌手<input value={draft.musicArtist || ""} onChange={(event) => setDraft({ ...draft, musicArtist: event.target.value })} /></label><label>作词<input value={draft.lyricist || ""} onChange={(event) => setDraft({ ...draft, lyricist: event.target.value })} /></label><label>作曲<input value={draft.composer || ""} onChange={(event) => setDraft({ ...draft, composer: event.target.value })} /></label><label className="wide">来源信息<input value={draft.source || ""} onChange={(event) => setDraft({ ...draft, source: event.target.value })} placeholder="例如：个人录入、实体唱片" /></label><label className="check-field"><input type="checkbox" checked={Boolean(draft.animeSong)} onChange={(event) => setDraft({ ...draft, animeSong: event.target.checked })} />动漫歌曲</label></>}
        {isVisual && <><label>画廊子类型<RoundedSelect value={draft.visualSubtype || "other"} onChange={(value) => setDraft({ ...draft, visualSubtype: normalizeVisualSubtype(value) })} options={Object.entries(visualSubtypeLabels || {}).map(([id, label]) => ({ value: id, label }))} ariaLabel="画廊子类型" /></label><label>作者<input value={draft.author || ""} onChange={(event) => setDraft({ ...draft, author: event.target.value })} /></label><label>Pixiv PID<input value={draft.pixivPid || ""} onChange={(event) => setDraft({ ...draft, pixivPid: event.target.value })} /></label><label>Twitter / X 来源<input value={draft.twitterSource || ""} onChange={(event) => setDraft({ ...draft, twitterSource: event.target.value })} /></label><label className="wide">来源链接<input type="url" value={draft.sourceUrl || ""} onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value })} /></label><label className="wide">标签<input value={(draft.characterTags || []).join("，")} onChange={(event) => setDraft({ ...draft, characterTags: splitTags(event.target.value) })} placeholder="用逗号分隔" /></label></>}
        {isVideo && <><label>平台<input value={draft.metadata?.platform || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, platform: event.target.value }) })} /></label><label>创作者<input value={draft.metadata?.creator || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, creator: event.target.value }) })} /></label><label>时长<input value={draft.metadata?.duration || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, duration: event.target.value }) })} placeholder="例如：03:42" /></label><label>视频子分类<RoundedSelect value={draft.videoSubtype || "other"} onChange={(value) => setDraft({ ...draft, videoSubtype: normalizeVideoSubtype(value) })} options={Object.entries(videoSubtypeLabels || {}).map(([id, label]) => ({ value: id, label: String(label) }))} ariaLabel="视频子分类" /></label><label>来源信息<input value={draft.metadata?.videoSource || ""} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, videoSource: event.target.value }) })} /></label><label>来源链接<input type="url" value={draft.sourceUrl || ""} onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value })} /></label></>}
        {isVideo ? <><label className="wide">封面图片<input type="url" value={draft.image || ""} onChange={(event) => setDraft({ ...draft, image: event.target.value })} placeholder="粘贴封面图片地址" /></label><label className="wide">缩略图<input type="url" value={draft.thumbnail || ""} onChange={(event) => setDraft({ ...draft, thumbnail: event.target.value })} placeholder="粘贴缩略图地址（可选）" /></label></> : <CoverField value={imageValue} label={isVisual ? "缩略图地址（仅保存缩略图）" : "封面图片"} placeholder={isVisual ? "粘贴缩略图地址" : "粘贴图片地址"} previewAlt={isVisual ? "缩略图预览" : "封面预览"} inputId="detail-image-input" uploading={imageUploading} onChange={setImageValue} onUpload={chooseImage} />}
        {!isVisual && !isVideo && <label>{isFilm ? "TMDB 评分" : "Bangumi 评分"}<input type="number" min="0" max="10" step="0.1" value={draft.globalScore || ""} onChange={(event) => setDraft({ ...draft, globalScore: Number(event.target.value) })} placeholder="0 - 10" /></label>}
        <label>所属合集<RoundedSelect value={draft.collection || ""} onChange={(value) => setDraft({ ...draft, collection: value })} options={[{ value: "", label: "不加入合集" }, ...collections.map((name) => ({ value: name, label: name }))]} ariaLabel="所属合集" /></label>
        <label className="wide">个人标签<input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="用逗号分隔，例如：热血，周更，想二刷" />{draft.tags.length > 0 && <span className="tag-editor-preview">{draft.tags.map((tag) => <em key={tag}>#{tag}</em>)}</span>}</label>
        <label className="wide">作品简介<textarea value={summaryValue} onChange={(event) => setDraft({ ...draft, metadata: normalizeMediaMetadata({ ...draft.metadata, overview: event.target.value, overviewOverride: true }) })} placeholder={summaryPending ? "正在读取详细资料…" : "可自定义、修改或清空作品简介"} /></label>
        <label className="wide">私人备注<textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
      </section>
      <div className="detail-source"><span>{isFilm ? `TMDB${draft.metadata?.tmdbId ? ` #${draft.metadata.tmdbId}` : ""}` : `${draft.source || setting.sources}${detailSubjectId ? ` · Bangumi #${detailSubjectId}` : ""}`}</span>{isFilm && draft.metadata?.tmdbId ? <a href={`https://www.themoviedb.org/${mediaType}/${draft.metadata.tmdbId}`} target="_blank" rel="noreferrer">查看 TMDB ↗</a> : detailSubjectId && <a href={`https://bgm.tv/subject/${detailSubjectId}`} target="_blank" rel="noreferrer">查看 Bangumi ↗</a>}</div>
      <footer><button className="danger-button" onClick={() => { if (window.confirm(`确定移除《${draft.title}》吗？`)) remove(draft.id); }}>移除条目</button><button className="primary-button" onClick={submit}>保存修改</button></footer>
    </div>
  </aside></div>;
}

function CompletionModal({ item, close, confirm }: { item?: Anime; close: () => void; confirm: () => void }) {
  if (!item) return null;
  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card completion-modal" role="dialog" aria-modal="true" aria-labelledby="complete-title">
    <div className="completion-icon">✓</div>
    <p>最后一个进度已记录</p>
    <h2 id="complete-title">要把《{item.title}》标记为已完成吗？</h2>
    <span>确认后会移动到“已完成”，所有进度和评分都会保留。</span>
    <div className="submit-row"><button onClick={close}>暂时不</button><button className="primary-button" onClick={confirm}>标记已完成</button></div>
  </section></div>;
}

function CalendarGridCard({ item, titleMode, toggle }: { item: CalendarEntry; titleMode: string; toggle: (item: CalendarEntry) => void }) {
  return <article className={item.followed ? "followed" : ""}>
    <CalendarPoster item={item} />
    <div><h4>{titleMode === "jp" ? item.jp : item.title}</h4><span className="source-tag">{item.source}</span><small>{item.meta}</small><button onClick={() => toggle(item)}>{item.followed ? "取消追更" : "＋ 加入追番"}</button></div>
  </article>;
}

type CalendarDisplayEntry = CalendarEntry & { schedule?: AiringSchedule };

function sourceName(value: string) {
  return value.split("+").map((source) => ({ bangumi: "Bangumi", anilist: "AniList", animeschedule: "AnimeSchedule", custom: "自定义" } as Record<string, string>)[source] || source).join(" + ");
}

function CalendarListRow({ item, titleMode, toggle, editCustom }: { item: CalendarDisplayEntry; titleMode: string; toggle: (item: CalendarEntry) => void; editCustom?: (item: AiringSchedule) => void }) {
  return <article className={`calendar-list-row ${item.followed ? "followed" : ""}`}>
    <CalendarPoster item={item} />
    <div className="calendar-list-copy"><h4>{titleMode === "jp" ? item.jp : item.title}</h4><span className="source-tag">{item.source}</span><small>{item.meta}</small></div>
    <div className="calendar-row-actions">{item.schedule?.source.includes("custom") && editCustom && <button onClick={() => editCustom(item.schedule!)}>编辑放送</button>}<button onClick={() => toggle(item)}>{item.followed ? "取消追更" : "＋ 加入追番"}</button></div>
  </article>;
}

type CustomAiringDraft = { id?: number; subjectId: string; title: string; jpTitle: string; weekday: number; airTime: string; nextEpisode: string; nextAirAt: string };
const emptyCustomAiring = (): CustomAiringDraft => ({ subjectId: "", title: "", jpTitle: "", weekday: 1, airTime: "", nextEpisode: "", nextAirAt: "" });
function localDateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function CalendarModal({ initialDay, close, titleMode, anime, airingSchedules, toggle, refreshSchedules }: { initialDay: CalendarDay; close: () => void; titleMode: string; anime: Anime[]; airingSchedules?: AiringSchedule[]; toggle: (item: CalendarEntry) => void; refreshSchedules: () => Promise<void> }) {
  const [activeDay, setActiveDay] = useState<CalendarDay>(initialDay);
  const [onlyMine, setOnlyMine] = useState(false);
  const [hideLong, setHideLong] = useState(false);
  const [source, setSource] = useState("all");
  const [sourceSchedules, setSourceSchedules] = useState<AiringSchedule[]>(airingSchedules || []);
  const [sourceBusy, setSourceBusy] = useState("");
  const [sourceMessage, setSourceMessage] = useState("");
  const [syncProgress, setSyncProgress] = useState(0);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<CustomAiringDraft>(emptyCustomAiring);
  const activeSchedules = source === "all" ? airingSchedules || [] : sourceSchedules;
  async function loadSource(nextSource = source) {
    const payload = await loadAiringSchedules({ source: nextSource === "all" ? undefined : nextSource });
    setSourceSchedules(payload.schedules || []);
  }
  async function selectSource(nextSource: string) {
    setSource(nextSource); setSourceBusy("loading"); setSourceMessage("");
    try { await loadSource(nextSource); } catch (error) { setSourceMessage(error instanceof Error ? error.message : "读取放送来源失败"); } finally { setSourceBusy(""); }
  }
  const providerLabels: Record<"bangumi" | "anilist" | "animeschedule", string> = { bangumi: "Bangumi", anilist: "AniList", animeschedule: "AnimeSchedule" };
  const syncSeason = activeSchedules[0]?.season || airingSchedules?.[0]?.season;
  const syncYear = activeSchedules[0]?.year || airingSchedules?.[0]?.year;
  async function syncSource(provider: "bangumi" | "anilist" | "animeschedule") {
    setSourceBusy(provider); setSourceMessage(""); setSyncProgress(0);
    try {
      const result = await syncAiringSchedules({ season: syncSeason, year: syncYear, source: provider }, (value) => setSyncProgress(value.progress));
      await refreshSchedules();
      await loadSource(source);
      setSourceMessage(`${providerLabels[provider]} 同步完成：${result.synced} 条`);
    } catch (error) { setSourceMessage(error instanceof Error ? error.message : "放送同步失败"); } finally { setSourceBusy(""); }
  }
  async function syncAllSources() {
    const providers: Array<"bangumi" | "anilist" | "animeschedule"> = ["bangumi", "anilist", "animeschedule"];
    const completed: string[] = [];
    const failed: string[] = [];
    setSourceBusy("all"); setSourceMessage(""); setSyncProgress(0);
    try {
      for (const [index, provider] of providers.entries()) {
        const start = Math.round((index / providers.length) * 100);
        const end = Math.round(((index + 1) / providers.length) * 100);
        setSourceMessage(`正在获取 ${providerLabels[provider]}…`);
        try {
          const result = await syncAiringSchedules({ season: syncSeason, year: syncYear, source: provider }, (value) => {
            const progress = Math.max(0, Math.min(100, Number(value.progress) || 0));
            setSyncProgress(Math.round(start + ((end - start) * progress) / 100));
          });
          completed.push(`${providerLabels[provider]} ${result.synced} 条`);
        } catch (error) {
          failed.push(`${providerLabels[provider]}：${error instanceof Error ? error.message : "同步失败"}`);
        }
      }
      await refreshSchedules();
      await loadSource(source);
      setSyncProgress(100);
      setSourceMessage(failed.length ? `已完成 ${completed.join("、") || "无"}；失败 ${failed.join("；")}` : `全部来源获取完成：${completed.join("、")}`);
    } finally {
      setSourceBusy("");
    }
  }
  function editCustom(item: AiringSchedule) {
    const customId = Number(item.metadata?.customScheduleId) || (item.source === "custom" ? item.id : 0);
    setCustomDraft({ id: customId || undefined, subjectId: String(item.subjectId || ""), title: item.title, jpTitle: item.jpTitle || "", weekday: item.weekday, airTime: item.airTime || "", nextEpisode: item.nextEpisode ? String(item.nextEpisode) : "", nextAirAt: localDateTimeInput(item.nextAirAt) });
    setCustomOpen(true);
  }
  async function saveCustom() {
    setSourceBusy("custom"); setSourceMessage("");
    try {
      await saveCustomAiring({ ...customDraft, subjectId: Number(customDraft.subjectId) || undefined, nextEpisode: Number(customDraft.nextEpisode) || undefined, nextAirAt: customDraft.nextAirAt || undefined, season: activeSchedules[0]?.season, year: activeSchedules[0]?.year });
      await refreshSchedules(); await loadSource(source);
      setSourceMessage(customDraft.id ? "自定义放送已更新" : "自定义放送已添加"); setCustomDraft(emptyCustomAiring()); setCustomOpen(false);
    } catch (error) { setSourceMessage(error instanceof Error ? error.message : "保存自定义放送失败"); } finally { setSourceBusy(""); }
  }
  async function deleteCustom() {
    if (!customDraft.id || !window.confirm("确认删除这条自定义放送吗？")) return;
    setSourceBusy("custom"); setSourceMessage("");
    try { await removeCustomAiring(customDraft.id); await refreshSchedules(); await loadSource(source); setSourceMessage("自定义放送已删除"); setCustomDraft(emptyCustomAiring()); setCustomOpen(false); } catch (error) { setSourceMessage(error instanceof Error ? error.message : "删除自定义放送失败"); } finally { setSourceBusy(""); }
  }
  const liveRows: CalendarDisplayEntry[] = activeSchedules.map((item) => {
    const images = item.metadata?.images;
    const image = images && typeof images === "object" ? (images as Record<string, unknown>).large || (images as Record<string, unknown>).common || (images as Record<string, unknown>).medium : "";
    return {
      title: item.title,
      jp: item.jpTitle,
      subjectId: item.subjectId,
      coverQuery: item.jpTitle || item.title,
      coverUrl: typeof image === "string" ? image.replace(/^http:\/\//i, "https://") : undefined,
      meta: `${item.airTime || "时间待定"} · 下一集 ${item.nextEpisode ?? "待定"}`,
      followed: Boolean(item.isCollected) || anime.some((tracked) => tracked.subjectId === item.subjectId || tracked.title === item.title || (tracked.jp && tracked.jp === item.jpTitle)),
      source: sourceName(item.source || "bangumi"),
      day: ["", "一", "二", "三", "四", "五", "六", "日"][item.weekday] as WeekDay,
      long: false,
      schedule: item,
    };
  }).filter((item) => item.day);
  const calendarRows = liveRows.map((item) => ({ ...item, followed: item.followed || anime.some((tracked) => tracked.title === item.title || (tracked.jp && tracked.jp === item.jp)) }));
  const visible = calendarRows.filter((item) => (activeDay === "all" || item.day === activeDay) && (!onlyMine || item.followed) && (!hideLong || !item.long));
  const heading = activeDay === "all" ? "整周放送" : `星期${activeDay}`;
  const seasonNames: Record<string, string> = { winter: "冬季", spring: "春季", summer: "夏季", fall: "秋季" };
  const season = activeSchedules[0]?.season || airingSchedules?.[0]?.season || "summer";
  const year = activeSchedules[0]?.year || airingSchedules?.[0]?.year || new Date().getFullYear();
  return <div className="overlay calendar-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="calendar-modal" role="dialog" aria-modal="true" aria-labelledby="calendar-title">
    <div className="calendar-header"><div><p>{year} · {seasonNames[season] || season}</p><h2 id="calendar-title">本季放送日历</h2></div><button onClick={close} aria-label="关闭">×</button></div>
    <div className="calendar-toolbar"><div className="calendar-tabs"><button className={activeDay === "all" ? "active" : ""} onClick={() => setActiveDay("all")}>整周放送</button>{week.map((day) => <button key={day} className={activeDay === day ? "active" : ""} onClick={() => setActiveDay(day as WeekDay)}>星期{day}</button>)}</div><div className="calendar-filters"><label className={onlyMine ? "active" : ""}><input type="checkbox" checked={onlyMine} onChange={(event) => setOnlyMine(event.target.checked)} /> 只看我的追番</label><label className={hideLong ? "active" : ""}><input type="checkbox" checked={hideLong} onChange={(event) => setHideLong(event.target.checked)} /> 隐藏长期连载</label></div></div>
    <div className="calendar-source-panel"><div className="calendar-source-tabs" aria-label="放送数据来源">{[["all", "全部来源"], ["bangumi", "Bangumi 官方"], ["anilist", "AniList 补充"], ["animeschedule", "AnimeSchedule"], ["custom", "用户自定义"]].map(([id, label]) => <button key={id} className={source === id ? "active" : ""} disabled={Boolean(sourceBusy)} onClick={() => void selectSource(id)}>{label}</button>)}</div><div className="calendar-source-actions"><button disabled={Boolean(sourceBusy)} onClick={() => void syncSource("bangumi")}>{sourceBusy === "bangumi" ? `Bangumi ${syncProgress}%` : "同步 Bangumi"}</button><button disabled={Boolean(sourceBusy)} onClick={() => void syncSource("anilist")}>{sourceBusy === "anilist" ? `AniList ${syncProgress}%` : "同步 AniList"}</button><button disabled={Boolean(sourceBusy)} onClick={() => void syncSource("animeschedule")}>{sourceBusy === "animeschedule" ? `AnimeSchedule ${syncProgress}%` : "同步 AnimeSchedule"}</button><button className="primary" disabled={Boolean(sourceBusy)} onClick={() => { setCustomDraft(emptyCustomAiring()); setCustomOpen((value) => !value); }}>＋ 自定义放送</button><button className="primary" disabled={Boolean(sourceBusy)} onClick={() => void syncAllSources()}>{sourceBusy === "all" ? `一键获取 ${syncProgress}%` : "一键获取全部"}</button></div></div>
    {customOpen && <div className="calendar-custom-form"><label>标题<input value={customDraft.title} onChange={(event) => setCustomDraft({ ...customDraft, title: event.target.value })} placeholder="动画名称" /></label><label>日文标题<input value={customDraft.jpTitle} onChange={(event) => setCustomDraft({ ...customDraft, jpTitle: event.target.value })} placeholder="可选" /></label><label>Bangumi Subject ID<input inputMode="numeric" value={customDraft.subjectId} onChange={(event) => setCustomDraft({ ...customDraft, subjectId: event.target.value })} placeholder="用于关联收藏，可选" /></label><label>星期<select value={customDraft.weekday} onChange={(event) => setCustomDraft({ ...customDraft, weekday: Number(event.target.value) })}>{week.map((day, index) => <option key={day} value={index + 1}>星期{day}</option>)}</select></label><label>更新时间<input type="time" value={customDraft.airTime} onChange={(event) => setCustomDraft({ ...customDraft, airTime: event.target.value })} /></label><label>下一集<input inputMode="numeric" value={customDraft.nextEpisode} onChange={(event) => setCustomDraft({ ...customDraft, nextEpisode: event.target.value })} placeholder="集数" /></label><label>下一集时间<input type="datetime-local" value={customDraft.nextAirAt} onChange={(event) => setCustomDraft({ ...customDraft, nextAirAt: event.target.value })} /></label><div className="calendar-custom-actions">{customDraft.id && <button className="danger-text" disabled={Boolean(sourceBusy)} onClick={() => void deleteCustom()}>删除</button>}<button disabled={Boolean(sourceBusy)} onClick={() => { setCustomOpen(false); setCustomDraft(emptyCustomAiring()); }}>取消</button><button className="primary" disabled={Boolean(sourceBusy) || !customDraft.title.trim()} onClick={() => void saveCustom()}>{customDraft.id ? "保存修改" : "添加放送"}</button></div></div>}
    {sourceMessage && <p className="calendar-source-message" role="status">{sourceMessage}</p>}
    <div className="calendar-body"><div className="calendar-day-title"><div><h3>{heading}</h3><p>当前条件下有 {visible.length} 部动画</p></div><span>{source === "all" ? "Bangumi + AniList + AnimeSchedule + 自定义" : sourceName(source)}</span></div>{activeDay === "all" ? <div className="calendar-week-groups">{week.map((day) => { const items = visible.filter((item) => item.day === day); return <section className="calendar-week-group" key={day}><header><h4>星期{day}</h4><span>{items.length} 部</span></header><div>{items.length ? items.map((item) => <CalendarListRow key={item.day + ":" + item.title} item={item} titleMode={titleMode} toggle={toggle} editCustom={editCustom} />) : <p className="calendar-group-empty">当天暂无更新</p>}</div></section>; })}</div> : <div className="calendar-grid">{visible.map((item) => <CalendarGridCard key={item.day + ":" + item.title} item={item} titleMode={titleMode} toggle={toggle} />)}{!visible.length && <div className="calendar-empty"><b>没有符合条件的动画</b><p>可以切换星期，或取消一个筛选条件。</p></div>}</div>}</div>
  </section></div>;
}

export { AddModal, CollectionManagerModal, CollectionModal, DetailDrawer, CompletionModal, CalendarGridCard, CalendarListRow, CalendarModal, VideoSubtypeModal, VisualSubtypeModal };
