/**
 * 可拆网盘组件：通用适配器约定与注册表。
 *
 * 设计原则（黄先生 2026-11-03 定）：
 * - 组件可随时去除：删掉本文件、app/api/backup/providers/ 与
 *   app/components/backup-panel.tsx，以及 security-panel.tsx 里
 *   的一行挂载，核心收藏、状态、媒体路由不受影响。
 * - 不深度绑定：核心代码只认 BackupProvider 这套约定，不直接
 *   import 任何一家网盘的 SDK 或 API。换网盘 = 在注册表里加
 *   一个实现同一约定的适配器，导出格式、导入逻辑都不用改。
 * - 凭据不进组件代码：网站侧网盘凭据沿用现有的
 *   external_service_credentials 表（provider 为键、服务端加密），
 *   本文件只读“是否已配置、来源、时间”，绝不返回 Token 明文。
 * - MEGA 不在网站注册表里：MEGA 是邮箱密码登录，Worker 内
 *   实现上传成本与风险都高，继续走东京服务器 rclone 那条路，
 *   见 docs/ 中的网盘归档约定；网站侧只在面板文案里说明。
 *
 * 当前状态（诚实标注，不虚报）：
 * - 百度（baidu）是首个网站侧适配器，但只完成了约定与状态
 *   占位：OAuth 应用注册、回调换 Token、刷新与上传 API
 *   尚未接通，uploadBackup 现在会明确报错，不会假装成功。
 *   接通前需要：在百度开放平台注册应用、把回调地址与
 *   Worker secret 配好，再实现回调与上传，届时只改
 *   baidu 适配器内部，不动核心与导出格式。
 */

export type BackupProviderKind = "oauth" | "external";

export type BackupProvider = {
  /** 与 external_service_credentials.provider 对应的键。 */
  id: string;
  label: string;
  kind: BackupProviderKind;
  description: string;
  /** 是否已具备在网站侧上传的条件；占位适配器永远为 false。 */
  ready: boolean;
  /** 未 ready 时，面板应原样展示的原因，不编造进度。 */
  notReadyReason: string | null;
};

export type BackupProviderStatus = {
  id: string;
  label: string;
  kind: BackupProviderKind;
  configured: boolean;
  source: "settings" | "environment" | null;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
  ready: boolean;
  notReadyReason: string | null;
};

export class BackupProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupProviderError";
  }
}

/**
 * 注册表是组件唯一的 provider 清单。新增网盘时只在这里加一项，
 * 并实现同一套 upload 方法；核心路由与面板只读注册表，不硬编码
 * 任何一家网盘的名字、域名或 API。
 */
export const BACKUP_PROVIDERS: BackupProvider[] = [
  {
    id: "baidu",
    label: "百度网盘",
    kind: "oauth",
    description: "网站侧 OAuth 绑定后，可把收藏导出文件手动上传到百度网盘。",
    ready: false,
    notReadyReason: "百度开放平台应用尚未注册，OAuth 回调与上传接口尚未接通。",
  },
];

export function getBackupProvider(id: string): BackupProvider | null {
  return BACKUP_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/**
 * 组件总开关（纯函数，方便测试）。
 * 路由层从 Worker env 读 BACKUP_COMPONENT_ENABLED 传进来：
 * 设为 "0" / "false" 时，备份接口与面板全部关闭，不需要删代码；
 * 彻底去除时再删文件。env 未配置时默认开启。
 */
export function isBackupComponentEnabledValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return !["0", "false", "off"].includes(String(value).toLowerCase());
}

/**
 * 百度适配器占位：只暴露“尚未接通”这一事实。
 * 以后接通时，本函数改为走服务端解密后的 OAuth Token
 * 调百度上传接口；调用方（面板 / 路由）的签名不需要变。
 */
export async function uploadBackupToProvider(
  providerId: string,
  file: { name: string; text: string },
): Promise<{ ok: false; reason: string }> {
  // 占位阶段不上传文件；保留参数签名，供接通后直接使用。
  void file;
  const provider = getBackupProvider(providerId);
  if (!provider) throw new BackupProviderError(`未知的备份网盘：${providerId}`);
  if (!provider.ready) {
    return { ok: false, reason: provider.notReadyReason ?? "该网盘尚未接通" };
  }
  // ready 的适配器以后在这里实现；现在注册表里没有任何 ready 项，
  // 走到这里说明注册表与实现不一致，宁可报错也不假装上传成功。
  throw new BackupProviderError(`网盘 ${provider.label} 标记为 ready，但未实现上传`);
}
