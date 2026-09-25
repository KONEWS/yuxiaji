export const MEDIA_STORAGE_LINK_LIMITS = {
  maxPerMedia: 12,
  provider: 64,
  label: 120,
  url: 2000,
  path: 1000,
  note: 1000,
} as const;

export type MediaStorageLinkInput = {
  provider: string;
  label: string;
  url: string;
  path: string;
  isPrimary: boolean;
  note: string;
};

export type MediaStorageLinkRow = MediaStorageLinkInput & {
  id: number;
  userKey: string;
  mediaId: number;
  createdAt: Date | number;
  updatedAt: Date | number;
};

export type PresentedMediaStorageLink = ReturnType<typeof presentMediaStorageLink>;

const CREDENTIAL_FIELD = /^(?:access|extract|pickup|share|提取|访问|取件)?[_-]?(?:code|码)$|^(?:pass(?:word|code)?|token|secret|credentials?|cookie|authorization|api[_-]?key)$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export class MediaStorageLinkValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "MediaStorageLinkValidationError";
  }
}

function textField(value: unknown, field: string, max: number) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new MediaStorageLinkValidationError(`${field} 必须是字符串`);
  const normalized = value.trim();
  if (normalized.length > max) throw new MediaStorageLinkValidationError(`${field} 最多 ${max} 个字符`);
  if (CONTROL_CHARACTER.test(normalized)) throw new MediaStorageLinkValidationError(`${field} 不能包含控制字符`);
  return normalized;
}

function booleanField(value: unknown, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  throw new MediaStorageLinkValidationError("isPrimary 必须是布尔值");
}

function rejectCredentialFields(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 4) return;
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_FIELD.test(key)) {
      throw new MediaStorageLinkValidationError(`不支持保存凭据字段 ${key}`);
    }
    rejectCredentialFields(candidate, depth + 1);
  }
}

export function normalizeMediaStorageProvider(value: unknown) {
  const provider = textField(value, "provider", MEDIA_STORAGE_LINK_LIMITS.provider)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
  if (!provider) throw new MediaStorageLinkValidationError("provider 不能为空");
  return provider;
}

export function normalizeMediaStorageUrl(value: unknown) {
  const input = textField(value, "url", MEDIA_STORAGE_LINK_LIMITS.url);
  if (!input) return "";
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new MediaStorageLinkValidationError("url 必须是有效的绝对地址");
  }
  if (!new Set(["https:", "http:"]).has(parsed.protocol)) {
    throw new MediaStorageLinkValidationError("url 仅支持 http 或 https 协议");
  }
  if (parsed.username || parsed.password) {
    throw new MediaStorageLinkValidationError("url 不能包含用户名或密码");
  }
  const normalized = parsed.toString();
  if (normalized.length > MEDIA_STORAGE_LINK_LIMITS.url) {
    throw new MediaStorageLinkValidationError(`url 最多 ${MEDIA_STORAGE_LINK_LIMITS.url} 个字符`);
  }
  return normalized;
}

export function sanitizeMediaStorageLink(
  value: unknown,
  fallback?: MediaStorageLinkInput,
): MediaStorageLinkInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaStorageLinkValidationError("存储链接必须是 JSON 对象");
  }
  rejectCredentialFields(value);
  const record = value as Record<string, unknown>;
  const provider = normalizeMediaStorageProvider(record.provider ?? fallback?.provider);
  const label = textField(record.label ?? fallback?.label, "label", MEDIA_STORAGE_LINK_LIMITS.label)
    .normalize("NFKC")
    .replace(/\s+/g, " ");
  const url = normalizeMediaStorageUrl(record.url ?? fallback?.url);
  const path = textField(record.path ?? fallback?.path, "path", MEDIA_STORAGE_LINK_LIMITS.path);
  const note = textField(record.note ?? fallback?.note, "note", MEDIA_STORAGE_LINK_LIMITS.note);
  if (!url && !path) throw new MediaStorageLinkValidationError("url 和 path 至少填写一项");
  return {
    provider,
    label,
    url,
    path,
    isPrimary: booleanField(record.isPrimary, fallback?.isPrimary),
    note,
  };
}

function timestamp(value: Date | number) {
  return value instanceof Date ? value.getTime() : value;
}

export function presentMediaStorageLink(row: MediaStorageLinkRow) {
  return {
    id: row.id,
    mediaId: row.mediaId,
    provider: row.provider,
    label: row.label,
    url: row.url,
    path: row.path,
    isPrimary: Boolean(row.isPrimary),
    note: row.note,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  };
}
