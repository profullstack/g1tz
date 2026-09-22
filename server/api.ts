/**
 * /api/v1: one identity for the browser (cookie) and the terminal (bearer),
 * one permission layer (operations.ts) for both.
 */
import { checksum, HttpError, type Store } from "./store.ts";
import { operate, type Context } from "./operations.ts";
import type { Mailer } from "./mail.ts";
import { FEATURES, PLAN_SPECS, PLANS, ROLE_LINES, ROLES } from "../src/teams-model.ts";

const MAX_BODY = 1100 * 1024;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Use application/json.");
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new HttpError(413, "Request too large.");
  const body = await request.text();
  if (body.length > MAX_BODY) throw new HttpError(413, "Request too large.");
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new HttpError(400, "A JSON object is required.");
  }
}

const buckets = new Map<string, { count: number; until: number }>();
export function limit(key: string, max = 300): void {
  const stamp = Date.now();
  if (buckets.size > 10000) for (const [k, v] of buckets) if (v.until < stamp) buckets.delete(k);
  let bucket = buckets.get(key);
  if (!bucket || bucket.until < stamp) {
    bucket = { count: 0, until: stamp + 60000 };
    buckets.set(key, bucket);
  }
  if (++bucket.count > max) throw new HttpError(429, "Too many requests. Try again in a minute.");
}

export function credential(request: Request, cookieName: string): { token: string; bearer: boolean } {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return { token: authorization.slice(7).trim(), bearer: true };
  const token = request.headers.get("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith(cookieName + "="))?.slice(cookieName.length + 1) || "";
  return { token, bearer: false };
}

export function createApi(store: Store, mail: Mailer, origin: string, cookieName: string) {
  return async (request: Request, ip = "local"): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) return null;
    const path = url.pathname.slice(8);
    try {
      if (path === "plans" && request.method === "GET") {
        return json({ plans: PLANS.map((p) => ({ plan: p, ...PLAN_SPECS[p] })), features: FEATURES, roles: ROLES.map((r) => ({ role: r, line: ROLE_LINES[r] })) }, 200, { "cache-control": "public, max-age=300" });
      }
      const sentOrigin = request.headers.get("origin");
      if (sentOrigin && sentOrigin !== origin) throw new HttpError(403, "Cross-origin API requests are not allowed.");
      const { token, bearer } = credential(request, cookieName);
      const user = token ? store.authenticate(token) : null;
      if (path === "me" && request.method === "GET") return json({ user });
      if (!user) throw new HttpError(401, "Sign in, or run g1tz login.");
      // The terminal ends its own session; the browser has /api/auth/logout.
      if (path === "logout" && request.method === "POST" && bearer) {
        store.run("DELETE FROM sessions WHERE tokenHash=?", checksum(token));
        return json({ ok: true });
      }
      limit(`user:${user.id}`);
      limit(`ip:${ip}`, 600);
      // A cookie can be sent by any site; a bearer token cannot. Browser writes
      // must say where they came from.
      if (request.method !== "GET" && !bearer && (!sentOrigin || request.headers.get("sec-fetch-site") === "cross-site")) throw new HttpError(403, "Browser writes require a same-origin Origin header.");
      store.ensureOrganization(user);
      const ctx: Context = { store, user, origin, mail };
      if (path === "actions" && request.method === "POST") {
        const data = await readJson(request);
        const args = data.args ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new HttpError(400, "args must be an object.");
        if (typeof data.operation !== "string") throw new HttpError(400, "operation is required.");
        return json(await operate(ctx, data.operation, args as Record<string, unknown>));
      }
      const download = path.match(/^organizations\/([\w-]+)\/(members|audit)\.csv$/);
      if (download && request.method === "GET") {
        const result = await operate(ctx, download[2] === "members" ? "members_export" : "audit_export", { orgId: download[1] }) as { csv: string; filename: string };
        return new Response(result.csv, { headers: { ...headers, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${result.filename}"` } });
      }
      throw new HttpError(404, "API route not found.");
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message, ...error.details }, error.status, error.status === 429 ? { "retry-after": "60" } : {});
      console.error("g1tz API error", error instanceof Error ? error.message : "Unknown error");
      return json({ error: "The server could not complete this request." }, 500);
    }
  };
}
