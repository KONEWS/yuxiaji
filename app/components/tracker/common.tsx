"use client";

import { useEffect, useRef, useState } from "react";
import { scoreLabels } from "../../lib/tracker-data";

export function CoverImage({ src, alt, className, placeholder }: { src: string; alt: string; className: string; placeholder: string }) {
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (!failed && image?.complete && image.naturalWidth === 0) setFailed(true);
  }, [src, failed]);
  return failed || !src
    ? <div className={`${className} poster-placeholder`} aria-label={`${alt}加载失败`}>{placeholder}</div>
    : <img ref={imageRef} className={className} src={src} alt={alt} onError={() => setFailed(true)} />;
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
  const selected = options.find((option) => String(option.value) === String(value)) || options[0];
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <div ref={root} className={`rounded-select ${className}`}>
    <button type="button" className="rounded-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((current) => !current)}><span>{selected?.label || "请选择"}</span><i className="rounded-select-chevron" aria-hidden="true" /></button>
    {open && <div className="rounded-select-menu" role="listbox" aria-label={ariaLabel}>{options.map((option) => <button type="button" role="option" aria-selected={String(option.value) === String(value)} key={String(option.value)} className={String(option.value) === String(value) ? "active" : ""} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}</div>}
  </div>;
}
