import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { externalServiceCredentials } from "../../../../db/schema";
import { guardBrowserApi, requireAdminSession } from "../../../lib/admin-auth";
import { BAIDU_PENDING_PROVIDER, baiduCallbackUrl } from "../../../lib/baidu-backup-oauth";
import {
  BACKUP_PROVIDERS,
  getBackupProvider,
  isBackupComponentEnabledValue,
  type BackupProviderStatus,
} from "../../../lib/backup-providers";

/**
 * 网盘组件状态路由（独立于收藏核心）。
 * 只返回“是否已配置、来源、时间”，绝不返回 Token 明文。
 * DELETE 只删指定 provider 在 external_service_credentials
 * 里的那一行，不动收藏数据；删完组件文件后本路由一并消失。
 */
function componentEnabled(): boolean {
  const runtimeEnv = env as typeof env & { BACKUP_COMPONENT_ENABLED?: string };
  return isBackupComponentEnabledValue(runtimeEnv.BACKUP_COMPONENT_ENABLED);
}

export async function GET(request: Request) {
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
  if (!componentEnabled()) {
    return Response.json(
      { ok: true, enabled: false, providers: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const db = getDb();
    const rows = await db.select().from(externalServiceCredentials);
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    const providers: BackupProviderStatus[] = BACKUP_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider.id);
      let authorizationExpiresAt: number | null = null;
      if (provider.id === "baidu" && row) {
        try {
          const expiry = JSON.parse(row.metadata).expiresAt;
          if (typeof expiry === "number" && Number.isFinite(expiry)) authorizationExpiresAt = expiry;
        } catch { /* Old or invalid metadata is not proof of authorization. */ }
      }
      return {
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        configured: provider.id === "baidu" ? authorizationExpiresAt !== null : Boolean(row),
        source: row ? "settings" : null,
        lastVerifiedAt: row?.lastVerifiedAt
          ? new Date(row.lastVerifiedAt as unknown as number).toISOString()
          : null,
        updatedAt: row?.updatedAt
          ? new Date(row.updatedAt as unknown as number).toISOString()
          : null,
        ready: provider.ready,
        notReadyReason: provider.notReadyReason,
        ...(provider.id === "baidu" ? { callbackUrl: baiduCallbackUrl(request), authorizationExpiresAt, authorizationExpired: authorizationExpiresAt !== null && authorizationExpiresAt <= Date.now() } : {}),
      };
    });
    return Response.json(
      { ok: true, enabled: true, providers },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取网盘配置失败" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function DELETE(request: Request) {
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
  if (!componentEnabled()) {
    return Response.json({ error: "备份组件已关闭" }, { status: 404 });
  }
  try {
    let body: Record<string, unknown> = {};
    try {
      const parsed = await request.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }
    const providerId = typeof body.provider === "string" ? body.provider : "";
    const provider = getBackupProvider(providerId);
    if (!provider) return Response.json({ error: "未知的备份网盘" }, { status: 400 });
    const current = await requireAdminSession(request);
    if (current instanceof Response) return current;
    const db = getDb();
    await db.delete(externalServiceCredentials).where(and(
      inArray(externalServiceCredentials.provider, providerId === "baidu" ? [providerId, BAIDU_PENDING_PROVIDER] : [providerId]),
      eq(externalServiceCredentials.adminId, current.account.id),
    ));
    return Response.json({ ok: true, provider: providerId });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "解绑网盘失败" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
