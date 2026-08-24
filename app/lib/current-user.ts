import { env } from "cloudflare:workers";

/**
 * Temporary user identity for personal Cloudflare Workers testing.
 * Replace this implementation with the real session/token resolver later.
 */
export function getCurrentUser(_request?: Request): string {
  void _request;
  const runtimeEnv = env as typeof env & { DEFAULT_USER_ID?: string };
  const configured = typeof runtimeEnv.DEFAULT_USER_ID === "string" ? runtimeEnv.DEFAULT_USER_ID.trim() : "";
  return configured || "owner";
}
