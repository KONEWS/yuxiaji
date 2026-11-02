import { getDb } from "../../../../db";
import { guardBrowserApi } from "../../../lib/admin-auth";
import { buildCollectionBackup } from "../../../lib/collection-backup-store";
import { collectionBackupFileName } from "../../../lib/collection-backup";
import { getCurrentUser } from "../../../lib/current-user";

/**
 * 收藏导出（备份组件，独立路由）。
 * 只读收藏三张表，不读、不返回任何管理员、会话、Token、凭据表。
 */
export async function GET(request: Request) {
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
  const key = getCurrentUser();
  try {
    const backup = await buildCollectionBackup(getDb(), key);
    return new Response(JSON.stringify(backup, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${collectionBackupFileName()}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "导出收藏失败" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
