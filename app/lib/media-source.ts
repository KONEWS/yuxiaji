export type MediaSource = "bangumi" | "vndb" | "manual" | "local";

export function normalizeMediaSource(value: unknown, fallback: MediaSource = "manual"): MediaSource {
  if (typeof value !== "string") return fallback;
  const source = value.trim().toLowerCase();
  if (source === "vndb" || source.includes("vndb") || source.includes("visual novel database")) return "vndb";
  if (source === "bangumi" || source.includes("bangumi") || source.includes("bgm")) return "bangumi";
  if (source === "local" || source.includes("local") || value.includes("本地") || value.includes("扫描") || value.includes("月下集")) return "local";
  if (source === "manual" || source.includes("manual") || value.includes("手动") || value.includes("个人录入")) return "manual";
  return fallback;
}
