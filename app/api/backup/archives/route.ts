import { env } from "cloudflare:workers";
import { guardBrowserApi } from "../../../lib/admin-auth";
import { getCurrentUser } from "../../../lib/current-user";
import { isBackupComponentEnabledValue } from "../../../lib/backup-providers";
import { advanceBackupArchive, configureBackup, createBackupArchive, getBackupSettings, listBackupArchives, withBackupLock, type BackupEnv } from "../../../lib/backup-archive";
import { SiteBackupError } from "../../../lib/site-backup-data";
const headers = { "cache-control": "no-store" };
const runtime = env as typeof env & BackupEnv;
export async function GET(request: Request) {
  const guard = await guardBrowserApi(request); if (guard) return guard;
  if (!isBackupComponentEnabledValue(runtime.BACKUP_COMPONENT_ENABLED)) return Response.json({ error: "备份功能已关闭" }, { status: 503, headers });
  try {
    const user = getCurrentUser();
    const settings = await getBackupSettings(env.BUCKET, user);
    const backups = await listBackupArchives(env.BUCKET, user);
    const latestScheduled = backups.find((record) => record.kind === "scheduled");
    return Response.json({ ok: true, settings, backups, lastError: latestScheduled?.status === "failed" ? latestScheduled.error : null }, { headers });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "读取备份失败" }, { status: error instanceof SiteBackupError ? error.status : 500, headers }); }
}
export async function POST(request: Request) {
  const guard = await guardBrowserApi(request); if (guard) return guard;
  if (!isBackupComponentEnabledValue(runtime.BACKUP_COMPONENT_ENABLED)) return Response.json({ error: "备份功能已关闭" }, { status: 503, headers });
  try {
    const body = await request.json() as Record<string, unknown>;
    const user = getCurrentUser();
    const result = await withBackupLock(env.BUCKET, user, async (assertBackupLease) => {
      const locked = { ...runtime, assertBackupLease };
      if (body.action === "create") return { backup: await createBackupArchive(locked, user) };
      if (body.action === "continue" && typeof body.id === "string") return { backup: await advanceBackupArchive(locked, user, body.id) };
      if (body.action === "configure") return { settings: await configureBackup(env.BUCKET, user, body.enabled, body.retentionDays) };
      throw new SiteBackupError("未知备份操作");
    });
    return Response.json({ ok: true, ...result }, { headers });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "备份失败" }, { status: error instanceof SiteBackupError ? error.status : 500, headers }); }
}
