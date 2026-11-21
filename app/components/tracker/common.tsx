"use client";

import { useEffect, useRef, useState } from "react";
import { scoreLabels } from "../../lib/tracker-data";

export { CoverImage, CoverPositionEditor } from "./cover-position-editor";

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
