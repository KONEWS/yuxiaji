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
 * - 百度（baidu）支持管理员填写应用凭据、OAuth 跳转与回调换 Token。
 *   每五天将完整 ZIP 备份保存到百度应用目录，传输由定时任务负责。
 *   授权逻辑独立在 baidu-backup-oauth.ts；应用和 Token 均加密保存。
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
  authorizationExpiresAt?: number | null;
  authorizationExpired?: boolean;
  callbackUrl?: string;
  backupStatus?: string;
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
    description: "每五天自动保存完整备份至应用目录下的「月下集备份」文件夹。",
    ready: true,
    notReadyReason: null,
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
