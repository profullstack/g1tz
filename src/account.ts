/**
 * Where the terminal keeps its sign-in: ~/.config/g1tz/cloud.json, mode 600,
 * written atomically. G1TZ_URL points at another server; G1TZ_TOKEN supplies
 * a token without a file (CI); G1TZ_CONFIG_DIR moves the directory.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "https://g1tz.hqtui.com";

export interface AccountUser { id: string; displayName: string; email: string }
export interface CloudConfig {
  url: string;
  token?: string;
  user?: AccountUser;
  expiresAt?: string;
  /** The organization commands act on when --org is not given. */
  org?: string;
}

export const configDir = (): string =>
  process.env.G1TZ_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "g1tz");

/** HTTPS, or HTTP on localhost only; no credentials, query or fragment. */
export function serverUrl(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && local))) {
    throw new Error("Use an HTTPS server URL (HTTP is allowed on localhost).");
  }
  return url.origin;
}

export function readConfig(root = configDir()): Partial<CloudConfig> {
  try {
    return JSON.parse(readFileSync(join(root, "cloud.json"), "utf8")) as Partial<CloudConfig>;
  } catch {
    return {};
  }
}

export function writeConfig(config: CloudConfig, root = configDir()): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "cloud.json");
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

export function clearConfig(root = configDir()): void {
  const path = join(root, "cloud.json");
  if (existsSync(path)) unlinkSync(path);
}

/**
 * The server and token to use now. A saved token never travels to a server
 * that an environment variable pointed elsewhere.
 */
export function cloudConfig(env: NodeJS.ProcessEnv = process.env, root = configDir()): CloudConfig {
  const saved = readConfig(root);
  const url = serverUrl(env.G1TZ_URL || saved.url || DEFAULT_URL);
  const envToken = env.G1TZ_TOKEN;
  const sameServer = !saved.url || serverUrl(saved.url) === url;
  return {
    url,
    token: envToken || (sameServer ? saved.token : undefined),
    user: envToken ? undefined : sameServer ? saved.user : undefined,
    expiresAt: sameServer ? saved.expiresAt : undefined,
    org: env.G1TZ_ORG || (sameServer ? saved.org : undefined),
  };
}
