import { createHash } from "node:crypto";
import { decryptCredential, encryptCredential } from "./bangumi-account";
import { backupUser, downloadBackupArchive, getBackupSettings, listBackupArchives, withBackupLock, type BackupEnv } from "./backup-archive";
import { isBackupComponentEnabledValue } from "./backup-providers";

const folder = "/apps/备份/月下集备份";
const fileApi = "https://pan.baidu.com/rest/2.0/xpan/file";
const locatorApi = "https://d.pcs.baidu.com/rest/2.0/pcs/file";
const blockSize = 4 * 1024 * 1024;
const interval = 5 * 86400000;

type Credential = { appKey: string; secretKey: string; accessToken: string; refreshToken: string; expiresAt: number };
type Job = { archive: string; date: string; part: number; count: number; bounded?: boolean };
type Metadata = { expiresAt: number; nextDue?: number; completed?: string; job?: Job; error?: string; retryAt?: number };
type Row = { token_ciphertext: string; metadata: string };
type Reply = { errno?: number; error_code?: number; path?: string; size?: number; fs_id?: number; uploadid?: string; block_list?: number[]; return_type?: number; md5?: string };
class BaiduFailure extends Error {
  constructor(stage: string, readonly code?: number) { super(stage + (code === undefined ? "" : "（" + code + "）")); }
}

function apiUrl(base: string, values: Record<string, string>) {
  const url = new URL(base);
  url.search = new URLSearchParams(values).toString();
  return url;
}

async function call(url: URL, stage: string, body: FormData | URLSearchParams): Promise<Reply> {
  try {
    const response = await fetch(url, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(60000) });
    const data: Reply = await response.json().catch(() => { throw new BaiduFailure(stage + "：非 JSON 响应", response.status); });
    const code = data.errno ?? data.error_code;
    if (!response.ok || (code !== undefined && code !== 0)) throw new BaiduFailure(stage, code ?? response.status);
    return data;
  } catch (error) {
    if (error instanceof BaiduFailure) throw error;
    throw new BaiduFailure(stage + "：网络或响应异常");
  }
}

async function refresh(old: Credential): Promise<Credential> {
  const url = apiUrl("https://openapi.baidu.com/oauth/2.0/token", {
    grant_type: "refresh_token", refresh_token: old.refreshToken, client_id: old.appKey, client_secret: old.secretKey,
  });
  const response = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15000) });
  const value = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!response.ok || !value.access_token || !value.refresh_token || !(Number(value.expires_in) > 0)) throw new BaiduFailure("百度令牌刷新失败，请重新授权");
  return { ...old, accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: Date.now() + Number(value.expires_in) * 1000 };
}

async function ensureFolder(token: string) {
  try {
    const result = await call(apiUrl(fileApi, { method: "create", access_token: token }), "创建月下集备份目录失败",
      new URLSearchParams({ path: folder, size: "0", isdir: "1", rtype: "0", block_list: "[]" }));
    if (result.path !== folder || !result.fs_id) throw new BaiduFailure("百度未确认备份目录");
  } catch (error) {
    if (!(error instanceof BaiduFailure && error.code === -8)) throw error;
  }
}

async function uploadHosts(token: string, path: string, uploadid: string) {
  const locator = apiUrl(locatorApi, { method: "locateupload", appid: "250528", upload_version: "2.0", access_token: token, path, uploadid });
  const response = await fetch(locator, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15000) });
  const info = await response.json().catch(() => null) as { servers?: { server?: string }[] } | null;
  const hosts: string[] = [];
  for (const { server } of info?.servers ?? []) {
    if (!server || !URL.canParse(server)) continue;
    const url = new URL(server);
    if (!["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password ||
        !/^(?:[a-z0-9-]+\.)*(?:baidupcs\.com|pcs\.baidu\.com)$/.test(url.hostname)) continue;
    hosts.push("https://" + url.hostname + "/rest/2.0/pcs/superfile2");
  }
  if (!hosts.length) throw new BaiduFailure("百度未返回可用的上传节点", response.status);
  return [...new Set(hosts)].slice(0, 3);
}

// Use small standalone restore-compatible ZIPs, leaving headroom for the manifest and HTTP buffers.
async function uploadPart(env: BackupEnv, token: string, user: string, job: Job) {
  const file = (method: string) => apiUrl(fileApi, { method, access_token: token });
  const zip = await downloadBackupArchive(env, user, job.archive, "zip", job.part, true);
  job.count = Number(zip.headers.get("x-backup-parts"));
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const hashes: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    hashes.push(createHash("md5").update(bytes.subarray(offset, offset + blockSize)).digest("hex"));
  }
  const path = folder + "/月下集-" + job.date + "-part-" + String(job.part).padStart(2, "0") + "-of-" + job.count + ".zip";
  const pre = await call(file("precreate"), "百度预上传失败", new URLSearchParams({
    path, isdir: "0", size: String(bytes.length), block_list: JSON.stringify(hashes), autoinit: "1", rtype: "3",
  }));
  if (pre.return_type === 2 && pre.path === path && pre.size === bytes.length && pre.fs_id) return;
  if (!pre.uploadid || !Array.isArray(pre.block_list) || pre.block_list.some(n => !Number.isInteger(n) || n < 0 || n >= hashes.length)) throw new BaiduFailure("百度预上传响应缺少分片信息");
  const hosts = pre.block_list.length ? await uploadHosts(token, path, pre.uploadid) : [];
  for (const n of pre.block_list) {
    const form = new FormData();
    form.append("file", new Blob([bytes.subarray(n * blockSize, (n + 1) * blockSize)]), "block");
    for (const [index, host] of hosts.entries()) {
      try {
        const result = await call(apiUrl(host, { method: "upload", access_token: token, type: "tmpfile", path, uploadid: pre.uploadid, partseq: String(n) }), "百度分片上传失败", form);
        if (result.md5?.toLowerCase() !== hashes[n]) throw new BaiduFailure("百度分片校验失败");
        break;
      } catch (error) {
        if (index === hosts.length - 1 || (error instanceof BaiduFailure && error.code && error.code < 0)) throw error;
      }
    }
  }
  const result = await call(file("create"), "百度合并 ZIP 失败", new URLSearchParams({
    path, size: String(bytes.length), isdir: "0", uploadid: pre.uploadid, block_list: JSON.stringify(hashes), rtype: "3",
  }));
  if (!result.fs_id || result.path !== path || result.size !== bytes.length) throw new BaiduFailure("百度未确认 ZIP 路径和大小");
}

export async function runBaiduBackup(env: BackupEnv, now = Date.now()) {
  if (!isBackupComponentEnabledValue(env.BACKUP_COMPONENT_ENABLED)) return;
  const read = () => env.DB.prepare("SELECT token_ciphertext,metadata FROM external_service_credentials WHERE provider='baidu'").first<Row>();
  const due = (m: Metadata) => (m.retryAt ?? 0) <= now && (m.nextDue ?? 0) <= now;
  const first = await read();
  if (!first || !due(JSON.parse(first.metadata))) return;
  const user = backupUser(env);
  if (!(await getBackupSettings(env.BUCKET, user)).enabled) return;
  return withBackupLock(env.BUCKET, user, async lease => {
    const row = await read();
    if (!row) return;
    const m: Metadata = JSON.parse(row.metadata);
    if (!due(m)) return;
    let ciphertext = row.token_ciphertext;
    const save = async (newCiphertext = ciphertext) => {
      await lease();
      const updated = await env.DB.prepare("UPDATE external_service_credentials SET metadata=?,token_ciphertext=? WHERE provider='baidu' AND token_ciphertext=? AND metadata=?")
        .bind(JSON.stringify(m), newCiphertext, ciphertext, row.metadata).run<D1Result>();
      if (updated.meta.changes !== 1) throw new Error("百度授权或进度已改变");
      row.metadata = JSON.stringify(m);
      ciphertext = newCiphertext;
    };
    try {
      const records = await listBackupArchives(env.BUCKET, user);
      if (m.job && !records.some(a => a.id === m.job?.archive && a.status === "complete")) delete m.job;
      if (!m.job) {
        // At 04:00 the new daily snapshot may still be copying its images.
        // Wait for that date instead of uploading yesterday and shortening the interval.
        const earliest = m.nextDue ? "daily-" + new Date(m.nextDue + 8 * 3600000).toISOString().slice(0, 10) : "";
        const archive = records.find(a => a.kind === "scheduled" && a.status === "complete" && a.id >= earliest);
        if (!archive) return;
        m.job = { archive: archive.id, date: archive.id.replace(/^daily-/, ""), part: 1, count: archive.downloadParts };
      }
      if (!m.job.bounded) { m.job = { archive: m.job.archive, date: m.job.date, count: 0, part: 1, bounded: true }; await save(); }
      let credential: Credential = JSON.parse(await decryptCredential(ciphertext));
      if (Math.min(m.expiresAt, credential.expiresAt) <= now + 3600000) {
        credential = await refresh(credential);
        m.expiresAt = credential.expiresAt;
        await save(await encryptCredential(JSON.stringify(credential)));
      }
      const job = m.job;
      if (job.part === 1) await ensureFolder(credential.accessToken);
      await uploadPart(env, credential.accessToken, user, job);
      job.part++;
      if (job.part > job.count) {
        m.completed = job.archive;
        m.nextDue = Date.parse(job.date + "T04:00:00+08:00") + interval;
        delete m.job;
      }
      delete m.error;
      delete m.retryAt;
      await save();
      return Boolean(m.job);
    } catch (error) {
      m.error = error instanceof BaiduFailure ? error.message : "网盘备份暂时失败，将自动重试";
      if (error instanceof BaiduFailure && [110,111,-6].includes(error.code ?? 0)) m.expiresAt = 0;
      m.retryAt = now + 5 * 60000;
      await save();
    }
  });
}
