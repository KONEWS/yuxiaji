"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  clampCoverPosition, clampCoverZoom, clampCoverOffset, coverLayout, defaultCoverFraming, moveCover,
  MAX_COVER_OFFSET, MAX_COVER_ZOOM, MIN_COVER_ZOOM,
  type CoverDimensions, type CoverFit, type CoverFraming, type CoverPoint,
} from "../../lib/cover-framing";

type Measurement = CoverDimensions & { src: string };
type CoverImageProps = {
  src: string; alt: string; className: string; placeholder: string; style?: CSSProperties;
  framing?: CoverFraming; fit?: CoverFit; onMeasure?: (dimensions: Measurement) => void;
};

export function CoverImage({ src, alt, className, placeholder, style, framing, fit = "cover", onMeasure }: CoverImageProps) {
  const [failedSrc, setFailedSrc] = useState("");
  const [size, setSize] = useState<Measurement | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);
  const framed = framing !== undefined;
  const failed = failedSrc === src;
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const image = imageRef.current;
    if (!frame || !image?.naturalWidth || !image.naturalHeight || !frame.clientWidth || !frame.clientHeight) return;
    const next = { src, frameWidth: frame.clientWidth, frameHeight: frame.clientHeight, imageWidth: image.naturalWidth, imageHeight: image.naturalHeight };
    setSize(old => old?.src === src && old.frameWidth === next.frameWidth && old.frameHeight === next.frameHeight
      && old.imageWidth === next.imageWidth && old.imageHeight === next.imageHeight ? old : next);
    onMeasure?.(next);
  }, [src, onMeasure]);

  useEffect(() => {
    const image = imageRef.current;
    if (!failed && image?.complete && image.naturalWidth === 0) setFailedSrc(src);
    const frame = frameRef.current;
    if (!framed || !frame || failed) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [src, framed, failed, measure]);
  if (failed || !src) return <div className={`${className} poster-placeholder`} aria-label={`${alt}加载失败`}>{placeholder}</div>;
  if (!framing) return <img ref={imageRef} className={className} src={src} alt={alt} loading="lazy" decoding="async" style={style} onError={() => setFailedSrc(src)} />;

  const layout = size?.src === src ? coverLayout(size, fit, framing) : null;
  const pictureStyle: CSSProperties = layout && size ? {
    width: layout.width, height: layout.height,
    left: (size.frameWidth - layout.width) / 2 + layout.centerX,
    top: (size.frameHeight - layout.height) / 2 + layout.centerY,
  } : { inset: 0, width: "100%", height: "100%", objectFit: fit };
  return <span className={`${className} cover-framing-frame`} ref={frameRef} style={style}>
    <img ref={imageRef} className="cover-framing-image" src={src} alt={alt} draggable={false}
      loading={onMeasure ? "eager" : "lazy"} decoding="async" referrerPolicy="no-referrer"
      style={pictureStyle} onLoad={measure} onError={() => setFailedSrc(src)} />
  </span>;
}

type Gesture = { framing: CoverFraming; from: CoverPoint; distance: number };
function pointerGeometry(points: Map<number, CoverPoint>) {
  const [first, second] = points.values();
  if (!first) return null;
  if (!second) return { point: first, distance: 0 };
  return { point: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    distance: Math.hypot(second.x - first.x, second.y - first.y) };
}

function framePoint(frame: HTMLDivElement, clientX: number, clientY: number): CoverPoint {
  const rect = frame.getBoundingClientRect();
  return { x: clientX - rect.left - frame.clientLeft - frame.clientWidth / 2,
    y: clientY - rect.top - frame.clientTop - frame.clientHeight / 2 };
}

const center = { x: 0, y: 0 };
export function CoverPositionEditor({ src, x, y, zoom, offsetX, offsetY, onChange, contain = false, alt = "封面位置预览" }: {
  src: string; x?: number; y?: number; zoom?: number; offsetX?: number; offsetY?: number;
  onChange: (x: number, y: number, zoom: number, offsetX: number, offsetY: number) => void;
  contain?: boolean; alt?: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, CoverPoint>());
  const gesture = useRef<Gesture | null>(null);
  const live = useRef<CoverFraming>({});
  const [size, setSize] = useState<Measurement | null>(null);
  const dimensions = size?.src === src ? size : null;
  const fit = contain ? "contain" : "cover";
  const framing = { coverPositionX: clampCoverPosition(x), coverPositionY: clampCoverPosition(y), coverZoom: clampCoverZoom(zoom),
    coverOffsetX: clampCoverOffset(offsetX), coverOffsetY: clampCoverOffset(offsetY) };
  const coverZoom = framing.coverZoom;
  useLayoutEffect(() => {
    live.current = { coverPositionX: x, coverPositionY: y, coverZoom: zoom, coverOffsetX: offsetX, coverOffsetY: offsetY };
  }, [x, y, zoom, offsetX, offsetY]);
  useEffect(() => {
    pointers.current.clear();
    gesture.current = null;
  }, [src]);
  const publish = useCallback((next: typeof defaultCoverFraming) => {
    live.current = next;
    onChange(next.coverPositionX, next.coverPositionY, next.coverZoom, next.coverOffsetX, next.coverOffsetY);
  }, [onChange]);
  const zoomAt = useCallback((value: number, point = center) => {
    if (!dimensions || clampCoverZoom(value) === clampCoverZoom(live.current.coverZoom)) return;
    publish(moveCover(dimensions, fit, live.current, value, point, point));
  }, [dimensions, fit, publish]);
  useEffect(() => {
    const frame = stage.current;
    if (!frame || !dimensions) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1);
      if (!pixels) return;
      const current = clampCoverZoom(live.current.coverZoom);
      const change = current * Math.expm1(-Math.max(-500, Math.min(500, pixels)) / 450);
      zoomAt(current + Math.sign(change) * Math.max(1, Math.abs(change)), framePoint(frame, event.clientX, event.clientY));
    };
    frame.addEventListener("wheel", wheel, { passive: false });
    return () => frame.removeEventListener("wheel", wheel);
  }, [dimensions, zoomAt]);

  const beginGesture = () => {
    const positions = pointerGeometry(pointers.current);
    gesture.current = positions && { framing: live.current, from: positions.point, distance: positions.distance };
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    beginGesture();
  };
  const layout = dimensions && coverLayout(dimensions, fit, framing);
  const panX = layout ? clampCoverOffset(layout.centerX / layout.spanX * 100) : 0;
  const panY = layout ? clampCoverOffset(layout.centerY / layout.spanY * 100) : 0;
  const panTo = (coverOffsetX: number, coverOffsetY: number) => publish({ ...defaultCoverFraming, coverZoom, coverOffsetX, coverOffsetY });
  return <section className="cover-position-editor">
    <div className="cover-position-heading"><b>封面构图</b><div className="cover-position-heading-actions">
      <button type="button" onClick={() => zoomAt(coverZoom - 10)} disabled={!dimensions || coverZoom <= MIN_COVER_ZOOM} aria-label="缩小封面">−</button>
      <span aria-live="polite">{coverZoom}%</span>
      <button type="button" onClick={() => zoomAt(coverZoom + 10)} disabled={!dimensions || coverZoom >= MAX_COVER_ZOOM} aria-label="放大封面">＋</button>
      <button type="button" onClick={() => publish(defaultCoverFraming)} disabled={framing.coverPositionX === 50 && framing.coverPositionY === 50 && coverZoom === 100 && !framing.coverOffsetX && !framing.coverOffsetY}>重置</button>
    </div></div>
    <div ref={stage} className={`cover-position-stage ${contain ? "contain" : ""}`}
      onPointerDown={(event) => {
        if (!dimensions || event.button !== 0 || pointers.current.size >= 2) return;
        pointers.current.set(event.pointerId, framePoint(event.currentTarget, event.clientX, event.clientY));
        event.currentTarget.setPointerCapture(event.pointerId);
        beginGesture();
      }}
      onPointerMove={(event) => {
        const start = gesture.current;
        const previous = pointers.current.get(event.pointerId);
        if (!dimensions || !start || !previous) return;
        const point = framePoint(event.currentTarget, event.clientX, event.clientY);
        if (point.x === previous.x && point.y === previous.y) return;
        pointers.current.set(event.pointerId, point);
        const next = pointerGeometry(pointers.current);
        if (!next) return;
        const nextZoom = clampCoverZoom(start.framing.coverZoom) * (start.distance > 0 ? next.distance / start.distance : 1);
        publish(moveCover(dimensions, fit, start.framing, nextZoom, start.from, next.point));
      }}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
    ><CoverImage className="cover-position-preview" src={src} alt={alt} placeholder="图片未加载" framing={framing} fit={fit} onMeasure={setSize} /></div>
    <div className="cover-position-ranges">
      <small>拖动图片调整位置，滚轮或双指调整大小。</small>
      <label><span>横向 <b>{panX}%</b></span><input type="range" min={-MAX_COVER_OFFSET} max={MAX_COVER_OFFSET} step="0.1" value={panX} disabled={!dimensions} onChange={event => panTo(Number(event.target.value), panY)} aria-label="封面横向位置" /></label>
      <label><span>纵向 <b>{panY}%</b></span><input type="range" min={-MAX_COVER_OFFSET} max={MAX_COVER_OFFSET} step="0.1" value={panY} disabled={!dimensions} onChange={event => panTo(panX, Number(event.target.value))} aria-label="封面纵向位置" /></label>
      <label><span>缩放 <b>{coverZoom}%</b></span><input type="range" min={MIN_COVER_ZOOM} max={MAX_COVER_ZOOM} step="1" value={coverZoom} disabled={!dimensions} onChange={event => zoomAt(Number(event.target.value))} aria-label="封面缩放" /></label>
    </div>
  </section>;
}
