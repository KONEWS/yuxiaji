/** Movies and standalone assets have no episode/chapter progress; TV does. */
export function normalizeEditableProgress(mediaType: string, totalValue: unknown, progressValue: unknown) {
  if (["music", "visual", "movie", "video"].includes(mediaType)) return { total: 1, progress: 0 };
  const rawTotal = Number(totalValue);
  const total = Number.isFinite(rawTotal) ? Math.max(1, Math.floor(rawTotal)) : 1;
  const rawProgress = Number(progressValue);
  const progress = Number.isFinite(rawProgress) ? Math.min(total, Math.max(0, Math.floor(rawProgress))) : 0;
  return { total, progress };
}
