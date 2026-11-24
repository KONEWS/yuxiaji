import { finishBaiduBackupOAuth, startBaiduBackupOAuth } from "../../../../lib/baidu-backup-oauth";

export async function POST(request: Request) {
  return startBaiduBackupOAuth(request);
}

export async function GET(request: Request) {
  return finishBaiduBackupOAuth(request);
}
