export const MIN_COVER_ZOOM = 25;
export const MAX_COVER_ZOOM = 500;
export const MAX_COVER_OFFSET = 50;
export const defaultCoverFraming = {
  coverPositionX: 50, coverPositionY: 50, coverZoom: 100, coverOffsetX: 0, coverOffsetY: 0,
};

export type CoverFraming = Partial<typeof defaultCoverFraming>;
export type CoverFit = "cover" | "contain";
export type CoverDimensions = { frameWidth: number; frameHeight: number; imageWidth: number; imageHeight: number };
export type CoverPoint = { x: number; y: number };

function boundedNumber(value: unknown, min: number, max: number, fallback: number) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function clampCoverPosition(value: unknown) {
  return Math.round(boundedNumber(value, 0, 100, 50));
}

export function clampCoverZoom(value: unknown) {
  return Math.round(boundedNumber(value, MIN_COVER_ZOOM, MAX_COVER_ZOOM, 100));
}

export function clampCoverOffset(value: unknown) {
  return Math.round(boundedNumber(value, -MAX_COVER_OFFSET, MAX_COVER_OFFSET, 0) * 100) / 100;
}

export function coverLayout(size: CoverDimensions, fit: CoverFit, framing: CoverFraming) {
  const widthRatio = size.frameWidth / size.imageWidth;
  const heightRatio = size.frameHeight / size.imageHeight;
  const fitScale = fit === "contain" ? Math.min(widthRatio, heightRatio) : Math.max(widthRatio, heightRatio);
  const scale = fitScale * clampCoverZoom(framing.coverZoom) / 100;
  const width = size.imageWidth * scale;
  const height = size.imageHeight * scale;
  const spanX = Math.max(size.frameWidth, width);
  const spanY = Math.max(size.frameHeight, height);
  // The old focal point places the same fraction of the image at that fraction of the frame.
  // Zero extra offset reproduces the saved composition at its original zoom.
  const centerX = (size.frameWidth - width) * (clampCoverPosition(framing.coverPositionX) / 100 - 0.5)
    + spanX * clampCoverOffset(framing.coverOffsetX) / 100;
  const centerY = (size.frameHeight - height) * (clampCoverPosition(framing.coverPositionY) / 100 - 0.5)
    + spanY * clampCoverOffset(framing.coverOffsetY) / 100;
  return { width, height, spanX, spanY, centerX, centerY };
}

// Points are in frame pixels, measured from its center. Keeping the grabbed
// image point under the pointer also handles a moving two-finger midpoint.
export function moveCover(size: CoverDimensions, fit: CoverFit, framing: CoverFraming, zoom: number, from: CoverPoint, to: CoverPoint) {
  const old = coverLayout(size, fit, framing);
  const coverZoom = clampCoverZoom(zoom);
  const ratio = coverZoom / clampCoverZoom(framing.coverZoom);
  const nextX = to.x + (old.centerX - from.x) * ratio;
  const nextY = to.y + (old.centerY - from.y) * ratio;
  return {
    ...defaultCoverFraming, coverZoom,
    coverOffsetX: clampCoverOffset(nextX * 100 / Math.max(size.frameWidth, old.width * ratio)),
    coverOffsetY: clampCoverOffset(nextY * 100 / Math.max(size.frameHeight, old.height * ratio)),
  };
}
