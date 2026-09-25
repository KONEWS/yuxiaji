/** Cloudflare Worker entry point for Yuexiaji. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { csrfFailure, getAdminSession } from "../app/lib/admin-auth";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  TMDB_API_KEY?: string;
  BANGUMI_TOKEN_ENCRYPTION_KEY?: string;
  YUEXIAJI_CREDENTIALS_ENCRYPTION_KEY?: string;
  ANIMESCHEDULE_TOKEN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Agent endpoints deliberately remain Bearer-token-only. They must never
    // fall through to the administrator's browser session.
    const isAgentEndpoint = url.pathname === "/api/agent" || url.pathname.startsWith("/api/agent/");
    const isAuthEndpoint = url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/");
    const isStatic = url.pathname.startsWith("/_next/") || url.pathname.startsWith("/assets/") || [
      "/favicon.ico",
      "/favicon.svg",
      "/favicon.png",
      "/favicon-32.png",
      "/favicon-192.png",
      "/apple-touch-icon.png",
      "/og.png",
      "/robots.txt",
    ].includes(url.pathname);
    const isLoginPage = url.pathname === "/login" || url.pathname.startsWith("/login/");
    if (!isAgentEndpoint && !isAuthEndpoint && !isStatic && !isLoginPage) {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const csrf = csrfFailure(request);
        if (csrf) return csrf;
      }
      try {
        const current = await getAdminSession(request);
        if (!current) {
          if (url.pathname.startsWith("/api/")) return Response.json({ error: "需要管理员登录" }, { status: 401, headers: { "cache-control": "no-store" } });
          return Response.redirect(new URL(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, request.url), 302);
        }
        if (current.account.mustChangePassword === true && url.pathname !== "/settings/security" && !url.pathname.startsWith("/api/auth/")) {
          if (url.pathname.startsWith("/api/")) return Response.json({ error: "请先修改临时密码", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403 });
          return Response.redirect(new URL("/settings/security?force=1", request.url), 302);
        }
      } catch (error) {
        if (url.pathname.startsWith("/api/")) return Response.json({ error: "认证服务不可用", details: error instanceof Error ? error.message : String(error) }, { status: 503 });
        return Response.redirect(new URL("/login?error=unavailable", request.url), 302);
      }
    } else if (isLoginPage && request.method === "GET") {
      try {
        const current = await getAdminSession(request);
        if (current) return Response.redirect(new URL(current.account.mustChangePassword ? "/settings/security?force=1" : "/", request.url), 302);
      } catch {
        // The login page remains available so a missing migration can be diagnosed.
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    // Some browsers still probe the conventional ICO path even when the
    // document declares PNG/SVG icons. Serve the existing 32px PNG instead of
    // letting the auth guard turn the probe into a login-page redirect.
    if (url.pathname === "/favicon.ico") {
      return env.ASSETS.fetch(new Request(new URL("/favicon-32.png", request.url), { method: request.method, headers: request.headers }));
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
