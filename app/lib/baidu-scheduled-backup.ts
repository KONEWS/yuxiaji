import { createHash } from "node:crypto";
import { decryptCredential, encryptCredential } from "./bangumi-account";
import { backupUser, prepareNetdiskZip, readNetdiskZipBlock, getBackupSettings, listBackupArchives, withBackupLock, type BackupEnv } from "./backup-archive";
import { isBackupComponentEnabledValue } from "./backup-providers";

function backupFolder(appName = "备份") {
  if (!appName.trim() || appName !== appName.trim() || appName === "." || appName === ".." ||
      /[\\/:*?"<>|]/.test(appName) || Array.from(appName).some(c => c.charCodeAt(0) < 32)) {
    throw new BaiduFailure("请将 BAIDU_BACKUP_APP_NAME 设置为注册应用的目录名");
  }
  return "/apps/" + appName + "/月下集备份";
}
const fileApi = "https://pan.baidu.com/rest/2.0/xpan/file";
const locatorApi = "https://d.pcs.baidu.com/rest/2.0/pcs/file";
const blockSize = 4 * 1024 * 1024;
const interval = 5 * 86400000;

type Credential = { appKey: string; secretKey: string; accessToken: string; refreshToken: string; expiresAt: number };
type Job = { archive: string; date: string; prefix: string; size: number; hashes: string[]; count: number; uploadid?: string; missing?: number[]; folder?: string; failures?: number };
type Metadata = { expiresAt: number; nextDue?: number; completed?: string; file?: { path: string; size: number; id: string }; job?: Job; error?: string; retryAt?: number };
type Row = { token_ciphertext: string; metadata: string };
type RemoteFile = { path?: string; size?: number | string; fs_id?: number | string; isdir?: number };
type Reply = RemoteFile & { errno?: number; error_code?: number; info?: RemoteFile; list?: RemoteFile[]; uploadid?: string; block_list?: number[]; return_type?: number; md5?: string };
class BaiduFailure extends Error {
  constructor(stage: string, readonly code?: number) { super(stage + (code === undefined ? "" : "（" + code + "）")); }
}

function apiUrl(base: string, values: Record<string, string>) {
  const url = new URL(base);
  url.search = new URLSearchParams(values).toString();
  return url;
}

async function call(url: URL, stage: string, body?: FormData | URLSearchParams): Promise<Reply> {
  try {
    const response = await fetch(url, { method: body ? "POST" : "GET", body, redirect: "manual", signal: AbortSignal.timeout(30000) });
    let data: Reply;
    try {
      // Keep 64-bit Netdisk IDs exact when Baidu sends an unquoted JSON integer.
      data = JSON.parse(await response.text(), (key, value, context?: { source?: string }) =>
        key === "fs_id" && typeof value === "number" ? context?.source ?? value : value);
    } catch { throw new BaiduFailure(stage + "：非 JSON 响应", response.status); }
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

async function ensureFolder(token: string, folder: string) {
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
  const fallback = "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2";
  const response = await fetch(locator, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(12000) }).catch(() => null);
  if (!response?.ok) return [fallback];
  const info = await response.json().catch(() => null) as { servers?: { server?: string }[] } | null;
  const hosts: string[] = [];
  for (const { server } of info?.servers ?? []) {
    if (!server || !URL.canParse(server)) continue;
    const url = new URL(server);
    if (!["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password ||
        !/^(?:[a-z0-9-]+\.)*(?:baidupcs\.com|pcs\.baidu\.com)$/.test(url.hostname)) continue;
    hosts.push("https://" + url.hostname + "/rest/2.0/pcs/superfile2");
  }
  return [...new Set([...hosts.slice(0, 2), fallback])];
}

function remoteId(id: RemoteFile["fs_id"]) {
  if (typeof id === "string" && /^[1-9]\d*$/.test(id)) return id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
}

async function confirmed(result: Reply, path: string, size: number, token: string) {
  const failure = () => new BaiduFailure("百度未确认 ZIP 路径和大小");
  const rows = [result, ...(result.info ? [result.info] : [])];
  const ids = new Set(rows.map(row => remoteId(row.fs_id)).filter(id => id !== undefined));
  if (ids.size > 1 || rows.some(row => (row.path !== undefined && row.path !== path)
      || (row.size !== undefined && Number(row.size) !== size) || Number(row.isdir) === 1)) throw failure();
  const [id] = ids;
  if (id && rows.some(row => row.path === path) && rows.some(row => Number(row.size) === size)) return { path, size, id };

  const lookup = await call(apiUrl(fileApi, { method: "search", access_token: token,
    dir: path.slice(0, path.lastIndexOf("/")), key: path.slice(path.lastIndexOf("/") + 1), recursion: "0" }), "查询百度备份文件失败");
  const matches = lookup.list?.filter(row => row.path === path && Number(row.size) === size && Number(row.isdir) !== 1);
  const found = matches?.length === 1 ? remoteId(matches[0].fs_id) : undefined;
  if (!found || (id && id !== found)) throw failure();
  return { path, size, id: found };
}

async function advanceZip(bucket: R2Bucket, token: string, user: string, job: Job, folder: string) {
  const path = folder + "/月下集-" + job.date + ".zip";
  const file = (method: string) => apiUrl(fileApi, { method, access_token: token });
  if (job.hashes.length < job.count) {
    const n = job.hashes.length;
    const offset = n * blockSize;
    const bytes = await readNetdiskZipBlock(bucket, user, job.prefix, offset, Math.min(blockSize, job.size - offset));
    const hash = createHash("md5").update(bytes).digest("hex");
    await bucket.put(job.prefix + n, bytes);
    job.hashes.push(hash);
    return;
  }
  const fields = { path, size: String(job.size), isdir: "0", block_list: JSON.stringify(job.hashes), rtype: "3" };
  if (!job.uploadid) {
    await ensureFolder(token, folder);
    const pre = await call(file("precreate"), "百度预上传失败", new URLSearchParams({ ...fields, autoinit: "1" }));
    if (pre.return_type === 2) return confirmed(pre, path, job.size, token);
    if (!pre.uploadid || !Array.isArray(pre.block_list) || pre.block_list.some(n => !Number.isInteger(n) || n < 0 || n >= job.count)) throw new BaiduFailure("百度预上传响应缺少分片信息");
    job.uploadid = pre.uploadid;
    job.missing = [...new Set(pre.block_list)];
    return;
  }
  if (job.missing?.length) {
    const n = job.missing[0];
    const object = await bucket.get(job.prefix + n);
    if (!object) throw new BaiduFailure("缺少已暂存的备份数据块");
    const form = new FormData();
    form.append("file", new Blob([await object.arrayBuffer()]), "block");
    const hosts = await uploadHosts(token, path, job.uploadid);
    for (const [index, host] of hosts.entries()) {
      try {
        const result = await call(apiUrl(host, { method: "upload", access_token: token, type: "tmpfile", path, uploadid: job.uploadid, partseq: String(n) }), "百度分片上传失败", form);
        if (result.md5?.toLowerCase() !== job.hashes[n]) throw new BaiduFailure("百度分片校验失败");
        break;
      } catch (error) {
        if (index === hosts.length - 1 || (error instanceof BaiduFailure && error.code && error.code < 0)) throw error;
      }
    }
    job.missing.shift();
    return;
  }
  const result = await call(file("create"), "百度合并 ZIP 失败", new URLSearchParams({ ...fields, uploadid: job.uploadid }));
  return confirmed(result, path, job.size, token);
}

async function clearStaging(bucket: R2Bucket, job: Job) {
  const keys = ["fixed", "index", ...job.hashes.map((_, n) => String(n))];
  for (let i = 0; i < keys.length; i += 512) await bucket.delete(keys.slice(i, i + 512).map(k => job.prefix + k));
}

export async function runBaiduBackup(env: BackupEnv, now = Date.now()) {
  if (!isBackupComponentEnabledValue(env.BACKUP_COMPONENT_ENABLED)) return;
  const read = () => env.DB.prepare("SELECT token_ciphertext,metadata FROM external_service_credentials WHERE provider='baidu'").first<Row>();
  const due = (m: Metadata) => (m.retryAt ?? 0) <= now && (!m.file || (m.nextDue ?? 0) <= now);
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
      if (!m.job?.prefix) {
        const records = (await listBackupArchives(env.BUCKET, user)).filter(a => a.kind === "scheduled" && a.status === "complete");
        const legacyId = m.job?.archive ?? (!m.file ? m.completed : undefined);
        const earliest = m.file && m.nextDue ? "daily-" + new Date(m.nextDue + 8 * 3600000).toISOString().slice(0, 10) : "";
        const archive = records.find(a => a.id === legacyId) ?? records.find(a => a.id >= earliest);
        if (!archive) return;
        const prepared = await prepareNetdiskZip(env.BUCKET, user, archive.id);
        m.job = { ...prepared, archive: archive.id, date: archive.id.replace(/^daily-/, ""), count: Math.ceil(prepared.size / blockSize), hashes: [] };
        delete m.error; delete m.retryAt;
        await save();
        return true;
      }
      let credential: Credential = JSON.parse(await decryptCredential(ciphertext));
      if (Math.min(m.expiresAt, credential.expiresAt) <= now + 3600000) {
        credential = await refresh(credential);
        m.expiresAt = credential.expiresAt;
        await save(await encryptCredential(JSON.stringify(credential)));
      }
      const job = m.job;
      const folder = backupFolder(env.BAIDU_BACKUP_APP_NAME);
      if ((job.folder ?? backupFolder()) !== folder) {
        // Upload IDs are scoped to a destination path. The staged ZIP blocks are reusable.
        delete job.uploadid;
        delete job.missing;
        delete job.failures;
      }
      job.folder = folder;
      const file = await advanceZip(env.BUCKET, credential.accessToken, user, job, folder);
      delete job.failures;
      if (file) {
        m.file = file;
        m.completed = job.archive;
        m.nextDue = Date.parse(job.date + "T04:00:00+08:00") + interval;
        delete m.job;
      }
      delete m.error;
      delete m.retryAt;
      await save();
      if (file) await clearStaging(env.BUCKET, job).catch(() => {});
      return Boolean(m.job);
    } catch (error) {
      m.error = error instanceof BaiduFailure ? error.message : "网盘备份暂时失败，将自动重试";
      if (error instanceof BaiduFailure && [110,111,-6].includes(error.code ?? 0)) m.expiresAt = 0;
      if (m.job?.uploadid && error instanceof BaiduFailure) {
        // Re-negotiate a stale upload session after repeat failures on the same step.
        m.job.failures = (m.job.failures ?? 0) + 1;
        if (m.job.failures >= 3) {
          delete m.job.uploadid;
          delete m.job.missing;
          delete m.job.failures;
        }
      }
      if (m.job?.prefix && m.job.hashes.length < m.job.count && !(await listBackupArchives(env.BUCKET, user)).some(a => a.id === m.job?.archive)) {
        await clearStaging(env.BUCKET, m.job);
        delete m.job;
      }
      m.retryAt = now + 5 * 60000;
      await save();
    }
  });
}
