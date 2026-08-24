import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../db";
import { adminAccount, adminAuthLogs, adminSessions } from "../../db/schema";

const SESSION_COOKIE = "__Host-yuexiaji_session";
const CHALLENGE_COOKIE = "__Host-yuexiaji_2fa";
const PASSWORD_ITERATIONS = 100_000;
const SESSION_DURATIONS = [86400, 604800, 1296000, 2592000, 31536000] as const;

export type AdminAccount = typeof adminAccount.$inferSelect;
export type AdminSession = typeof adminSessions.$inferSelect;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function derivePassword(password: string, salt: Uint8Array, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBuffer, iterations, hash: "SHA-256" }, key, 256);
  return bytesToBase64Url(new Uint8Array(bits));
}

export async function hashPassword(password: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derivePassword(password, salt);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${hash}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, iterationText, saltText, expected] = encoded.split("$");
  if (algorithm !== "pbkdf2-sha256" || !iterationText || !saltText || !expected) return false;
  const iterations = Number(iterationText);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) return false;
  try {
    const actual = await derivePassword(password, base64UrlToBytes(saltText), iterations);
    return actual === expected;
  } catch {
    return false;
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Uint8Array) {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += BASE32[(buffer << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string) {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export function generateTotpSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export function totpUri(secret: string, username: string) {
  return `otpauth://totp/${encodeURIComponent("月下集:" + username)}?secret=${secret}&issuer=${encodeURIComponent("月下集")}&algorithm=SHA1&digits=6&period=30`;
}

async function hotp(secret: string, counter: number) {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}

export async function verifyTotp(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code.trim()) || !secret) return false;
  const counter = Math.floor(now / 30_000);
  for (const offset of [-1, 0, 1]) {
    if ((await hotp(secret, counter + offset)) === code.trim()) return true;
  }
  return false;
}

async function hashBackupCode(code: string) {
  return sha256(code.trim().toUpperCase());
}

export async function createBackupCodes(count = 10) {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = randomToken(8).slice(0, 10).toUpperCase();
    plain.push(code);
    hashes.push(await hashBackupCode(code));
  }
  return { plain, hashes };
}

export async function consumeBackupCode(account: AdminAccount, code: string) {
  if (!code.trim()) return false;
  let hashes: string[] = [];
  try { hashes = JSON.parse(account.backupCodes) as string[]; } catch { return false; }
  const hash = await hashBackupCode(code);
  const index = hashes.indexOf(hash);
  if (index < 0) return false;
  hashes.splice(index, 1);
  await getDb().update(adminAccount).set({ backupCodes: JSON.stringify(hashes), updatedAt: new Date() }).where(eq(adminAccount.id, account.id));
  return true;
}

function requestIp(request: Request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
}

function requestAgent(request: Request) {
  return (request.headers.get("user-agent") || "").slice(0, 500);
}

export async function writeAuthLog(request: Request, event: string, details: { username?: string; sessionId?: number; metadata?: Record<string, unknown> } = {}) {
  try {
    await getDb().insert(adminAuthLogs).values({
      event,
      username: details.username || "",
      sessionId: details.sessionId,
      ip: requestIp(request),
      userAgent: requestAgent(request),
      metadata: JSON.stringify(details.metadata || {}),
      createdAt: new Date(),
    });
  } catch {
    // Authentication should not fail just because an audit write is unavailable.
  }
}

/**
 * Load the one and only administrator by its stable primary key. Keeping this
 * query explicit avoids returning an accidentally stale/extra row and makes it
 * clear that account state is never copied into a browser Session.
 */
export async function loadAdminAccount(accountId = 1) {
  const [account] = await getDb().select().from(adminAccount).where(eq(adminAccount.id, accountId)).limit(1);
  return account || null;
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") || "";
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function cookieHeader(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() { return cookieHeader(SESSION_COOKIE, "", 0); }

export async function createSession(request: Request, accountId: number, durationSeconds: number, pending = false) {
  // Validate the singleton account at creation time, but do not copy any
  // account flags into the Session row. Those flags are read by
  // validateAdminSession on every request.
  if (!await loadAdminAccount(accountId)) throw new Error("管理员账户不存在");
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + durationSeconds * 1000);
  const [session] = await getDb().insert(adminSessions).values({
    sessionTokenHash: await sha256(token), createdAt: now, expiresAt: expires, lastUsedAt: now,
    userAgent: requestAgent(request), ip: requestIp(request), pending,
  }).returning();
  if (!session) throw new Error("创建 Session 失败");
  return { token, session, cookie: cookieHeader(pending ? CHALLENGE_COOKIE : SESSION_COOKIE, token, durationSeconds) };
}

async function loadSession(request: Request, includePending = false) {
  const raw = cookieValue(request, includePending ? CHALLENGE_COOKIE : SESSION_COOKIE);
  if (!raw) return null;
  const now = new Date();
  const conditions = [eq(adminSessions.sessionTokenHash, await sha256(raw)), eq(adminSessions.pending, includePending)];
  const [session] = await getDb().select().from(adminSessions).where(and(...conditions)).limit(1);
  if (!session) return null;
  const expires = session.expiresAt instanceof Date ? session.expiresAt : new Date(Number(session.expiresAt));
  if (expires.getTime() <= now.getTime()) {
    await getDb().delete(adminSessions).where(eq(adminSessions.id, session.id));
    return null;
  }
  return session;
}

/**
 * Validate a browser Session and then fetch the current account row. The
 * Session contains only a token hash and timestamps; flags such as
 * `mustChangePassword` are deliberately read fresh on every request.
 */
export async function validateAdminSession(request: Request) {
  const session = await loadSession(request, false);
  if (!session) return null;
  const account = await loadAdminAccount(1);
  if (!account) return null;
  await getDb().update(adminSessions).set({ lastUsedAt: new Date() }).where(eq(adminSessions.id, session.id));
  // Re-read after session validation so callers cannot accidentally retain an
  // account object created before a concurrent password/setup update.
  const freshAccount = await loadAdminAccount(account.id);
  return freshAccount ? { account: freshAccount, session } : null;
}

export async function getAdminSession(request: Request) {
  return validateAdminSession(request);
}

export async function getPendingChallenge(request: Request) { return loadSession(request, true); }

export async function requireAdminSession(request: Request) {
  try {
    const result = await getAdminSession(request);
    return result || Response.json({ error: "需要管理员登录" }, { status: 401, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "认证服务不可用", details: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export function csrfFailure(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "CSRF 校验失败" }, { status: 403 });
  if (request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "CSRF 校验失败" }, { status: 403 });
  return null;
}

export function publicAccount(account: AdminAccount | null) {
  if (!account) return null;
  return { id: account.id, username: account.username, twoFactorEnabled: account.twoFactorEnabled, mustChangePassword: account.mustChangePassword, sessionDuration: account.sessionDuration };
}

export function sessionDurations() { return [...SESSION_DURATIONS]; }
export { SESSION_COOKIE, CHALLENGE_COOKIE };

export async function loginFailureCount(request: Request, username: string) {
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await getDb().select({ id: adminAuthLogs.id }).from(adminAuthLogs).where(and(eq(adminAuthLogs.event, "login_failed"), eq(adminAuthLogs.username, username), gte(adminAuthLogs.createdAt, since))).limit(11);
  return rows.length;
}

export async function listSessions() {
  return getDb().select().from(adminSessions).where(eq(adminSessions.pending, false)).orderBy(desc(adminSessions.lastUsedAt));
}
