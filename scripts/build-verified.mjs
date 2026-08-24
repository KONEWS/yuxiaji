import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.SITES_RUNTIME_ROOT || resolve(projectRoot, ".sites-runtime");
const runtimeDirs = ["home", "npm-cache", "xdg-config", "tmp", "wrangler/logs"];
await Promise.all(runtimeDirs.map((dir) => mkdir(resolve(runtimeRoot, dir), { recursive: true })));

const binName = process.platform === "win32" ? "vinext.cmd" : "vinext";
const vinext = resolve(projectRoot, "node_modules", ".bin", binName);
const env = {
  ...process.env,
  SITES_ENV_READY: "1",
  SITES_PROJECT_ROOT: projectRoot,
  HOME: resolve(runtimeRoot, "home"),
  XDG_CONFIG_HOME: resolve(runtimeRoot, "xdg-config"),
  TMPDIR: resolve(runtimeRoot, "tmp"),
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: resolve(runtimeRoot, "wrangler/logs"),
  MINIFLARE_REGISTRY_PATH: resolve(runtimeRoot, "wrangler/registry"),
  npm_config_cache: resolve(runtimeRoot, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

const child = spawn(vinext, ["build"], { cwd: projectRoot, env, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
const timeoutMs = Number(process.env.SITES_BUILD_TIMEOUT_MS || 180000);
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 10000).unref();
}, timeoutMs);

const exitCode = await new Promise((resolveExit) => {
  child.on("error", () => resolveExit(1));
  child.on("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
});
clearTimeout(timer);
process.exitCode = exitCode;
