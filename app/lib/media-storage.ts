import { env } from "cloudflare:workers";

function versionFromUrl(value: unknown) {
  if (typeof value !== "string") return null;
  // Only relative URLs emitted by our upload endpoint are eligible. An
  // external URL with the same path must never be interpreted as our object.
  if (!value.trim().startsWith("/api/media-assets?")) return null;
  try {
    const parsed = new URL(value, "https://local.invalid");
    if (parsed.pathname !== "/api/media-assets") return null;
    const version = parsed.searchParams.get("v")?.trim() || "";
    if (/^[0-9]{1,20}$/.test(version)) return Number(version) > 0 ? version : null;
    return /^[A-Za-z0-9_-]{16,96}$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

async function userHash(userKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userKey));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Delete a thumbnail previously uploaded through /api/media-assets. */
export async function deleteMediaAsset(value: unknown, userKey: string) {
  const version = versionFromUrl(value);
  if (!version) return false;
  try {
    const bucket = env.BUCKET as unknown as { delete?: (key: string) => Promise<void> };
    if (!bucket.delete) return false;
    await bucket.delete(`media-assets/${await userHash(userKey)}/gallery/${version}`);
    return true;
  } catch {
    // Storage cleanup is deliberately best-effort; the database mutation has
    // already succeeded and should not be rolled back for an R2 outage.
    return false;
  }
}
