import { env } from "cloudflare:workers";
import { guardBrowserApi } from "../../../lib/admin-auth";
import { getCurrentUser } from "../../../lib/current-user";
import { isBackupComponentEnabledValue } from "../../../lib/backup-providers";
import { downloadBackupArchive, finishArchiveUpload, previewArchiveRestore, readLimitedBody, restoreBackupArchive, startArchiveUpload, uploadArchiveAsset, withBackupLock, type BackupEnv } from "../../../lib/backup-archive";
import { SiteBackupError } from "../../../lib/site-backup-data";
const headers = { "cache-control": "no-store" };
const runtime = env as typeof env & BackupEnv;
function failure(error: unknown, preRestoreBackupId?: string) {
  return Response.json({ error: error instanceof Error ? error.message : "备份操作失败", code: error instanceof SiteBackupError ? error.code : "backup_error", ...(preRestoreBackupId ? { preRestoreBackupId, rolledBack: error instanceof SiteBackupError ? error.rolledBack : false } : {}) }, { status: error instanceof SiteBackupError ? error.status : 500, headers });
}
async function guard(request: Request) {
  const denied = await guardBrowserApi(request); if (denied) return denied;
  if (!isBackupComponentEnabledValue(runtime.BACKUP_COMPONENT_ENABLED)) return Response.json({ error: "备份功能已关闭" }, { status: 503, headers });
  return null;
}
export async function GET(request: Request) {
  const denied = await guard(request); if (denied) return denied;
  try { const url = new URL(request.url); return await downloadBackupArchive(runtime, getCurrentUser(), url.searchParams.get("id") || "", url.searchParams.get("format") || "zip", Number(url.searchParams.get("part") || 1)); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const denied = await guard(request); if (denied) return denied;
  let preRestoreBackupId: string | undefined;
  try {
    const bytes = await readLimitedBody(request, 20 * 1024 * 1024);
    let body: Record<string, unknown>;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new SiteBackupError("请求必须是有效 JSON"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SiteBackupError("请求必须是 JSON 对象");
    const user = getCurrentUser();
    preRestoreBackupId = typeof body.preRestoreBackupId === "string" ? body.preRestoreBackupId : undefined;
    if (body.action === "preview" && typeof body.id === "string") return Response.json({ ok: true, ...await previewArchiveRestore(runtime, user, body.id) }, { headers });
    const result = await withBackupLock(env.BUCKET, user, async (assertBackupLease) => {
      const locked = { ...runtime, assertBackupLease };
      if (body.action === "restore" && typeof body.id === "string" && typeof body.expectedFingerprint === "string" && body.confirmed === true) return restoreBackupArchive(locked, user, body.id, body.expectedFingerprint, preRestoreBackupId);
      if (body.action === "upload-start") return startArchiveUpload(locked, user, body.manifest);
      if (body.action === "upload-finish" && typeof body.id === "string") return { backup: await finishArchiveUpload(locked, user, body.id) };
      throw new SiteBackupError("请先预览并确认恢复，或选择有效的备份操作");
    });
    return Response.json({ ok: true, ...result }, { status: "needsMore" in result || "needsPreparation" in result ? 202 : 200, headers });
  } catch (error) { return failure(error, preRestoreBackupId); }
}
export async function PUT(request: Request) {
  const denied = await guard(request); if (denied) return denied;
  try {
    const url = new URL(request.url); const user = getCurrentUser();
    const bytes = await readLimitedBody(request, 8 * 1024 * 1024);
    const backup = await withBackupLock(env.BUCKET, user, (assertBackupLease) => uploadArchiveAsset({ ...runtime, assertBackupLease }, user, url.searchParams.get("id") || "", url.searchParams.get("sha256") || "", bytes));
    return Response.json({ ok: true, backup }, { headers });
  } catch (error) { return failure(error); }
}
