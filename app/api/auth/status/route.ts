import { getAdminSession, loadAdminAccount, publicAccount } from "../../../lib/admin-auth";

export async function GET(request: Request) {
  try {
    const account = await loadAdminAccount();
    const session = await getAdminSession(request);
    return Response.json({ initialized: Boolean(account), authenticated: Boolean(session), account: publicAccount(session?.account || null) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "读取认证状态失败" }, { status: 503 });
  }
}
