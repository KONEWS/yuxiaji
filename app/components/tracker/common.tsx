"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { scoreLabels } from "../../lib/tracker-data";

export function clampCoverPosition(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.min(100, Math.max(0, number))) : 50;
}

export function clampCoverZoom(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.min(240, Math.max(100, number))) : 100;
}

export function coverPositionStyle(x?: number, y?: number, zoom?: number): CSSProperties {
  const positionX = clampCoverPosition(x);
  const positionY = clampCoverPosition(y);
  const scale = clampCoverZoom(zoom) / 100;
  // Translate the enlarged image in image-space percentages. This makes a
  // focal point visible on both axes even when object-fit itself only crops
  // one axis for the source aspect ratio.
  const translate = (position: number) => `${((50 - position) * (scale - 1) / scale).toFixed(3)}%`;
  return {
    objectPosition: `${positionX}% ${positionY}%`,
    ...(scale > 1 ? { transform: `scale(${scale}) translate(${translate(positionX)}, ${translate(positionY)})`, transformOrigin: "center", willChange: "transform" } : {}),
  };
}

export function CoverImage({ src, alt, className, placeholder, style }: { src: string; alt: string; className: string; placeholder: string; style?: CSSProperties }) {
  const [failedSrc, setFailedSrc] = useState("");
  const imageRef = useRef<HTMLImageElement>(null);
  const failed = failedSrc === src;
  useEffect(() => {
    const image = imageRef.current;
    if (!failed && image?.complete && image.naturalWidth === 0) setFailedSrc(src);
  }, [src, failed]);
  return failed || !src
    ? <div className={`${className} poster-placeholder`} aria-label={`${alt}加载失败`}>{placeholder}</div>
    : <img ref={imageRef} className={className} src={src} alt={alt} style={style} onError={() => setFailedSrc(src)} />;
}

export function CoverPositionEditor({ src, x, y, zoom, onChange, contain = false, alt = "封面位置预览" }: {
  src: string;
  x?: number;
  y?: number;
  zoom?: number;
  onChange: (x: number, y: number, zoom?: number) => void;
  contain?: boolean;
  alt?: string;
}) {
  const positionX = clampCoverPosition(x);
  const positionY = clampCoverPosition(y);
  const coverZoom = clampCoverZoom(zoom);
  const pointerId = useRef<number | null>(null);
  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nextX = clampCoverPosition(((event.clientX - rect.left) / rect.width) * 100);
    const nextY = clampCoverPosition(((event.clientY - rect.top) / rect.height) * 100);
    onChange(nextX, nextY, coverZoom);
  };
  return <section className="cover-position-editor">
    <div className="cover-position-heading"><b>封面位置</b><div className="cover-position-heading-actions"><button type="button" onClick={() => onChange(positionX, positionY, clampCoverZoom(coverZoom - 10))} disabled={coverZoom <= 100} aria-label="缩小封面" title="缩小">−</button><span aria-live="polite">{coverZoom}%</span><button type="button" onClick={() => onChange(positionX, positionY, clampCoverZoom(coverZoom + 10))} disabled={coverZoom >= 240} aria-label="放大封面" title="放大">＋</button><button type="button" onClick={() => onChange(50, 50, 100)} disabled={positionX === 50 && positionY === 50 && coverZoom === 100}>重置</button></div></div>
    <div
      className={`cover-position-stage ${contain ? "contain" : ""}`}
      onPointerDown={(event) => {
        pointerId.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      }}
      onPointerMove={(event) => { if (pointerId.current === event.pointerId) updateFromPointer(event); }}
      onPointerUp={(event) => {
        if (pointerId.current !== event.pointerId) return;
        pointerId.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => { if (pointerId.current === event.pointerId) pointerId.current = null; }}
    ><img src={src} alt={alt} draggable={false} style={coverPositionStyle(positionX, positionY, coverZoom)} referrerPolicy="no-referrer" /><i aria-hidden="true" style={{ left: `${positionX}%`, top: `${positionY}%` }} /></div>
    <div className="cover-position-ranges">
      <label><span>横向 <b>{positionX}%</b></span><input type="range" min="0" max="100" value={positionX} style={{ background: `linear-gradient(to right, var(--primary-strong) 0 ${positionX}%, #dfe6e8 ${positionX}% 100%)` }} onChange={(event) => onChange(Number(event.target.value), positionY, coverZoom)} aria-label="封面横向位置" /></label>
      <label><span>纵向 <b>{positionY}%</b></span><input type="range" min="0" max="100" value={positionY} style={{ background: `linear-gradient(to right, var(--primary-strong) 0 ${positionY}%, #dfe6e8 ${positionY}% 100%)` }} onChange={(event) => onChange(positionX, Number(event.target.value), coverZoom)} aria-label="封面纵向位置" /></label>
      <label><span>缩放 <b>{coverZoom}%</b></span><input type="range" min="100" max="240" step="5" value={coverZoom} style={{ background: `linear-gradient(to right, var(--primary-strong) 0 ${((coverZoom - 100) / 140) * 100}%, #dfe6e8 ${((coverZoom - 100) / 140) * 100}% 100%)` }} onChange={(event) => onChange(positionX, positionY, Number(event.target.value))} aria-label="封面缩放" /></label>
    </div>
  </section>;
}

export function Rating({ score = 0, onRate }: { score?: number; onRate: (score: number) => void }) {
  const [hover, setHover] = useState(0);
  const preview = hover || score;
  return <div className="rating" aria-label="我的评分" onMouseLeave={() => setHover(0)}>
    <div className="rating-stars">{Array.from({ length: 10 }, (_, index) => <button type="button" key={index} className={preview > index ? "on" : ""} onMouseEnter={() => setHover(index + 1)} onFocus={() => setHover(index + 1)} onBlur={() => setHover(0)} onClick={() => onRate(index + 1)} aria-label={`${index + 1}分：${scoreLabels[index + 1]}`}>★</button>)}</div>
    <span><small>我的评分</small><b>{preview ? `${preview} · ${scoreLabels[preview]}` : "未评分"}</b></span>
  </div>;
}

export type RoundedSelectOption<T extends string | number> = { value: T; label: string };

export function RoundedSelect<T extends string | number>({ value, options, onChange, ariaLabel, className = "" }: { value: T; options: RoundedSelectOption<T>[]; onChange: (value: T) => void; ariaLabel: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pointerGesture = useRef<{ id: number; x: number; y: number } | null>(null);
  const suppressNextClick = useRef(false);
  const selected = options.find((option) => String(option.value) === String(value)) || options[0];
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnResize = () => setOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const closeOnScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !root.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, []);
  return <div ref={root} className={`rounded-select ${className}`}>
    <button type="button" className="rounded-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((current) => !current)}><span>{selected?.label || "请选择"}</span><i className="rounded-select-chevron" aria-hidden="true" /></button>
    {open && <div
      className="rounded-select-menu"
      role="listbox"
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        suppressNextClick.current = false;
        if (event.pointerType === "mouse") {
          pointerGesture.current = null;
          return;
        }
        pointerGesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const gesture = pointerGesture.current;
        if (!gesture || gesture.id !== event.pointerId) return;
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
          suppressNextClick.current = true;
        }
      }}
      onPointerUp={(event) => {
        if (pointerGesture.current?.id === event.pointerId) pointerGesture.current = null;
      }}
      onPointerCancel={(event) => {
        if (pointerGesture.current?.id === event.pointerId) {
          suppressNextClick.current = true;
          pointerGesture.current = null;
        }
      }}
    >{options.map((option) => <button type="button" role="option" aria-selected={String(option.value) === String(value)} key={String(option.value)} className={String(option.value) === String(value) ? "active" : ""} onClick={(event) => {
      if (event.detail > 0 && suppressNextClick.current) {
        suppressNextClick.current = false;
        event.preventDefault();
        return;
      }
      suppressNextClick.current = false;
      onChange(option.value);
      setOpen(false);
    }}>{option.label}</button>)}</div>}
  </div>;
}
