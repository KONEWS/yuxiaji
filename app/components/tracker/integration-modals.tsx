"use client";

import { useEffect, useRef, useState } from "react";
import type { SyncField, SyncProvider, SyncSettings } from "../../lib/constants";
import type { HealthReport, ConnectionItem, MediaType, SyncTarget } from "../../lib/tracker-types";
import { SecurityPanel } from "../security-panel";

function SyncMenu({ close, syncing, open }: { close: () => void; syncing: SyncTarget | null; open: (target: SyncTarget) => void }) {
  return <div className="sync-menu"><div className="popover-head"><b>同步收藏</b><button onClick={close}>×</button></div>
    <button disabled={Boolean(syncing)} onClick={() => open("bangumi_pull")}><i className="cyan">↓</i><span><b>从 Bangumi 导入</b><small>选择范围后拉取账号收藏、状态、评分与进度</small></span><em>→</em></button>
    <button disabled={Boolean(syncing)} onClick={() => open("bangumi_push")}><i className="purple">↑</i><span><b>同步到 Bangumi</b><small>选择范围后写回来源条目的状态与进度</small></span><em>→</em></button>
    <button disabled={Boolean(syncing)} onClick={() => open("bangumi")}><i className="dual">番</i><span><b>刷新条目资料</b><small>选择范围后更新标题、评分与封面</small></span><em>→</em></button>
  </div>;
}

function SyncModal({ target, close, run, syncing, bangumiSyncTypes, toggleBangumiType }: { target: SyncTarget; close: () => void; run: (target: SyncTarget) => void; syncing: SyncTarget | null; bangumiSyncTypes: MediaType[]; toggleBangumiType: (type: MediaType) => void }) {
  const syncOptions: Array<[MediaType, string]> = [["anime", "动画"], ["game", "游戏"], ["light_novel", "书籍"], ["manga", "漫画"], ["music", "音乐"]];
  const labels: Record<SyncTarget, { eyebrow: string; description: string; action: string; busy: string; hint: string }> = {
    bangumi_pull: { eyebrow: "从 Bangumi 导入", description: "选择需要导入月下集的 Bangumi 收藏类型。已有 Bangumi 条目会更新，其他来源的数据不会被覆盖。", action: "开始导入收藏", busy: "正在导入收藏", hint: "拉取账号收藏、状态、评分与进度" },
    bangumi_push: { eyebrow: "同步到 Bangumi", description: "选择需要写回 Bangumi 的来源类型。只处理来源为 Bangumi 的条目，不会删除月下集数据。", action: "开始写入 Bangumi", busy: "正在写入 Bangumi", hint: "写回状态、评分、标签、备注与进度" },
    bangumi: { eyebrow: "刷新条目资料", description: "选择需要从 Bangumi 公共目录刷新的媒体类型；字段更新遵循来源同步设置。", action: "立即刷新已选目录", busy: "正在刷新已选目录", hint: "按来源同步设置更新标题、评分与封面" },
  };
  const copy = labels[target];
  const active = syncing === target;
  const selectedCount = syncOptions.filter(([type]) => bangumiSyncTypes.includes(type)).length;
  return <div className="overlay settings-secondary-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget && !syncing) close(); }}><section className="modal-card settings-secondary-modal sync-dialog-modal" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title"><div className="modal-title"><div><p>{copy.eyebrow}</p><h2 id="sync-dialog-title">Bangumi 同步范围</h2></div><button onClick={close} disabled={Boolean(syncing)} aria-label="关闭同步窗口">×</button></div><p className="settings-secondary-description">{copy.description}</p><div className="sync-scope-heading"><b>同步范围</b><span>已选择 {selectedCount} 类</span></div><div className="sync-type-options">{syncOptions.map(([type, label]) => <button key={type} disabled={Boolean(syncing)} className={bangumiSyncTypes.includes(type) ? "active" : ""} onClick={() => toggleBangumiType(type)} aria-pressed={bangumiSyncTypes.includes(type)}><i>{bangumiSyncTypes.includes(type) ? "✓" : ""}</i>{label}</button>)}</div><button className="account-row sync-dialog-action" disabled={Boolean(syncing) || selectedCount === 0} onClick={() => run(target)}><i>{target === "bangumi_pull" ? "↓" : target === "bangumi_push" ? "↑" : "番"}</i><span><b>{active ? copy.busy : copy.action}</b><small>{copy.hint}</small></span><em>{active ? "同步中" : `${selectedCount} 类 →`}</em></button></section></div>;
}

function ThemeColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const commit = (input: HTMLInputElement) => { if (/^#[0-9a-f]{6}$/i.test(input.value)) onChange(input.value.toUpperCase()); else input.value = value; };
  return <div className="color-option"><input className="color-picker" type="color" value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} aria-label={`${label}取色器`} /><label><b>{label}</b><input defaultValue={value} onBlur={(event) => commit(event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget); }} aria-label={`${label} HEX 色值`} /></label></div>;
}

function SettingsModal(props: {
  font: string; setFont: (value: string) => void;
  primaryColor: string; setPrimaryColor: (value: string) => void;
  accentColor: string; setAccentColor: (value: string) => void;
  softness: number; setSoftness: (value: number) => void;
  titleMode: string; setTitleMode: (value: string) => void;
  avatarUrl: string; chooseAvatar: (file?: File) => void; resetAvatar: () => void;
  uploadBackground: (file?: File) => void;
  syncSettings: SyncSettings; toggleSyncSetting: (provider: SyncProvider, field: SyncField) => void;
  close: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const syncSources: Array<[SyncProvider, string, string]> = [["bangumi", "Bangumi", "公共目录资料"], ["vndb", "VNDB", "视觉小说资料"]];
  const syncFields: Array<[SyncField, string]> = [["cover", "封面"], ["title", "标题"], ["overview", "简介"], ["score", "评分"]];
  return <><div className="overlay sheet-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) props.close(); }}><section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div className="modal-title"><div><p>偏好设置</p><h2 id="settings-title">外观与数据源</h2></div><button onClick={props.close}>×</button></div>
    <section className="settings-section avatar-settings"><div className="settings-label"><b>头像</b><span>支持 JPG、PNG、WebP 或 GIF</span></div><div className="avatar-control"><div className="avatar-preview">{props.avatarUrl ? <img src={props.avatarUrl} alt="自定义头像预览" /> : <span>泽</span>}</div><div><input ref={avatarInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => { props.chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ""; }} /><button type="button" onClick={() => avatarInput.current?.click()}>选择头像</button>{props.avatarUrl && <button type="button" onClick={props.resetAvatar}>恢复默认</button>}</div></div></section>
    <section className="settings-section"><div className="settings-label"><b>主题颜色</b><button className="reset-colors" onClick={() => { props.setPrimaryColor("#66CCFF"); props.setAccentColor("#8B8CD8"); }}>恢复默认</button></div><div className="color-options"><ThemeColorControl key={`primary-${props.primaryColor}`} label="主色" value={props.primaryColor} onChange={props.setPrimaryColor} /><ThemeColorControl key={`accent-${props.accentColor}`} label="辅色" value={props.accentColor} onChange={props.setAccentColor} /></div></section>
    <section className="settings-section"><div className="settings-label"><b>界面字体</b></div><div className="font-options"><button className={props.font === "modern" ? "active" : ""} onClick={() => props.setFont("modern")}><b>现代黑体</b><span>月下集</span></button><button className={props.font === "round" ? "active" : ""} onClick={() => props.setFont("round")}><b>清爽圆体</b><span>轻快一点</span></button><button className={props.font === "serif" ? "active" : ""} onClick={() => props.setFont("serif")}><b>书卷宋体</b><span>安静耐看</span></button></div></section>
    <section className="settings-section"><div className="settings-label"><b>标题显示</b><span>仅显示所选标题</span></div><div className="title-options"><button className={props.titleMode === "cn" ? "active" : ""} onClick={() => props.setTitleMode("cn")}><b>中文优先</b><small>葬送的芙莉莲</small></button><button className={props.titleMode === "jp" ? "active" : ""} onClick={() => props.setTitleMode("jp")}><b>日文优先</b><small>葬送のフリーレン</small></button></div></section>
    <section className="settings-section"><div className="settings-label"><b>背景图片</b></div><div className="background-control"><div><span>自定义背景会自动淡化</span></div><input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => props.uploadBackground(event.target.files?.[0])} /><button onClick={() => fileInput.current?.click()}>选择图片</button><label>淡化 {props.softness}%<input type="range" min="35" max="94" value={props.softness} onChange={(event) => props.setSoftness(Number(event.target.value))} /></label></div></section>
    <section className="settings-section sync-settings"><div className="settings-label"><b>来源同步设置</b><span>选择允许自动更新的字段</span></div><p>修改来源 ID 或执行资料刷新时，仅更新已勾选的字段；进度、收藏状态和个人标签不会改变。</p><div className="source-sync-grid">{syncSources.map(([provider, label, description]) => <section className="source-sync-card" key={provider}><div className="source-sync-heading"><b>{label}</b><small>{description}</small></div><div className="source-sync-options">{syncFields.map(([field, fieldLabel]) => <label key={field} className="source-sync-toggle"><input type="checkbox" checked={props.syncSettings[provider][field]} onChange={() => props.toggleSyncSetting(provider, field)} /><span>{fieldLabel}</span></label>)}</div></section>)}</div></section>
    <section className="settings-section"><div className="settings-label"><b>账户安全</b><span>管理员登录、2FA、Bangumi 与设备 Session</span></div><button className="account-row" onClick={() => setSecurityOpen(true)}><i>锁</i><span><b>打开账户安全</b><small>修改密码、绑定 Bangumi、管理验证器和注销设备</small></span><em>→</em></button></section>
  </section></div>{securityOpen && <div className="overlay security-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setSecurityOpen(false); }}><div className="security-modal" role="dialog" aria-modal="true" aria-label="账户安全"><SecurityPanel embedded onClose={() => setSecurityOpen(false)} /></div></div>}</>;
}

function ConnectivityModal({ close }: { close: () => void }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestVersion, setRequestVersion] = useState(0);
  useEffect(() => {
    let active = true;
    fetch("/api/health", { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error("health check failed"); return await response.json() as HealthReport; })
      .then((payload) => { if (active) setReport(payload); })
      .catch(() => { if (active) setReport({ checkedAt: new Date().toISOString(), services: [] }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [requestVersion]);

  const icons: Record<string, string> = { database: "库", bangumi: "番", vndb: "VN", anilist: "播", animeschedule: "时" };
  const rows: ConnectionItem[] = (report?.services || []).map((service) => ({
    icon: icons[service.id] || "源", name: service.name, description: service.description,
    status: service.status || (service.ok ? "正常" : "异常"), latency: service.latency ? `${service.latency} ms` : "—", tone: service.status === "未配置" ? "gray" : service.ok ? "cyan" : "purple",
  }));
  const healthy = report?.services.filter((service) => service.ok).length || 0;
  const total = report?.services.length || 5;
  const lastChecked = report ? new Date(report.checkedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
  const retry = () => { setLoading(true); setRequestVersion((version) => version + 1); };

  return <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card connectivity-modal" role="dialog" aria-modal="true"><div className="modal-title"><div><p>真实检测</p><h2>连通性检查</h2></div><button onClick={close}>×</button></div><div className="connect-summary"><div><b>{loading ? "检测中" : `${healthy} / ${total}`}</b><span>{loading ? "正在连接服务" : healthy === total ? "核心服务正常" : "部分来源异常或未配置"}</span></div><small>最近检测 · {lastChecked}</small><button disabled={loading} onClick={retry}>{loading ? "检测中…" : "重新检测"}</button></div><div className="connection-group"><h3>应用与放送数据源</h3>{loading && !rows.length ? <div className="connection-loading">正在检查数据库、Bangumi、VNDB、AniList 与 AnimeSchedule…</div> : rows.length ? rows.map((item) => <ConnectionRow key={item.name} item={item} />) : <div className="connection-loading error">检测请求失败，请稍后重试。</div>}</div></section></div>;
}

function ConnectionRow({ item }: { item: ConnectionItem }) { return <div className={`connection-row ${item.tone}`}><i>{item.icon}</i><span><b>{item.name}</b><small>{item.description}</small></span><em><b>{item.status}</b><small>{item.latency}</small></em></div>; }

export { SyncMenu, SyncModal, SettingsModal, ConnectivityModal };
