/**
 * Talking to the teams server: one request shape, one action shape, and the
 * device-code sign-in that gives a terminal its token without pasting one.
 */
import { cloudConfig, type AccountUser, type CloudConfig } from "./account.ts";

export class CloudError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function cloudRequest<T = Record<string, unknown>>(
  path: string,
  method = "GET",
  body?: unknown,
  config: CloudConfig = cloudConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const response = await fetchImpl(`${config.url}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/json",
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new CloudError(response.status, `${config.url} did not answer with JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new CloudError(response.status, String(data.error || `HTTP ${response.status}`), data);
  return data as T;
}

export function cloudAction<T = Record<string, unknown>>(
  operation: string,
  args: Record<string, unknown> = {},
  config: CloudConfig = cloudConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  if (!config.token) throw new CloudError(401, "Sign in first: g1tz login  (or set G1TZ_TOKEN).");
  return cloudRequest<T>("/api/v1/actions", "POST", { operation, args }, config, fetchImpl);
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceLoginOptions {
  config: CloudConfig;
  label?: string;
  fetchImpl?: FetchLike;
  /** Shown the code and the URL; a TTY prints them, a test records them. */
  prompt: (start: DeviceStart) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Ask for a code, show it, poll until the browser decides. Resolves with the
 * token and the person it belongs to.
 */
export async function deviceLogin(options: DeviceLoginOptions): Promise<{ token: string; expiresAt: string; user: AccountUser }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const start = await cloudRequest<DeviceStart>("/api/auth/device", "POST", { label: options.label }, { url: options.config.url }, fetchImpl);
  options.prompt(start);
  const deadline = now() + start.expires_in * 1000;
  let interval = Math.max(1, start.interval) * 1000;
  while (now() < deadline) {
    await sleep(interval);
    try {
      return await cloudRequest<{ token: string; expiresAt: string; user: AccountUser }>("/api/auth/device/token", "POST", { device_code: start.device_code }, { url: options.config.url }, fetchImpl);
    } catch (error) {
      if (!(error instanceof CloudError)) throw error;
      if (error.status === 428) continue;
      if (error.status === 429) { interval += 2000; continue; }
      throw new Error(String(error.body.message ?? error.message));
    }
  }
  throw new Error("The code expired before it was approved. Run g1tz login again.");
}
