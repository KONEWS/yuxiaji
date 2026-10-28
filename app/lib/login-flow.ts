export type LoginStatus = {
  initialized: boolean;
  authenticated: boolean;
  account?: { username: string; mustChangePassword: boolean } | null;
};

export function safeLoginNext(value: string | null): string {
  if (!value?.startsWith("/") || /[\\\u0000-\u0020\u007f]/.test(value)) return "/";
  const base = "https://login.invalid";
  try {
    const destination = new URL(value, base);
    return destination.origin === base ? destination.pathname + destination.search + destination.hash : "/";
  } catch {
    return "/";
  }
}

export async function readLoginStatus(response: Response): Promise<LoginStatus> {
  if (!response.ok) throw new Error("认证服务暂时不可用，请重试");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("initialized" in payload) || !("authenticated" in payload)
    || typeof payload.initialized !== "boolean" || typeof payload.authenticated !== "boolean") {
    throw new Error("认证服务返回异常，请重试");
  }
  return payload as LoginStatus;
}
