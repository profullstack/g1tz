/**
 * The g1tz teams service: static pages from ../site, the account API, the
 * operations API, the OpenAccess descriptor and its entitlement webhook.
 *
 *   G1TZ_URL     public origin (default http://127.0.0.1:PORT)
 *   G1TZ_DB      SQLite path (default ./data/g1tz.sqlite; :memory: for tests)
 *   RESEND_API_KEY, G1TZ_MAIL_FROM   sign-in links and invitations
 *   OPENACCESS_HUB                   the hub whose keys sign entitlement webhooks
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "./accounts.ts";
import { createApi } from "./api.ts";
import { mailer, type Mailer } from "./mail.ts";
import { applyEntitlement, DEFAULT_HUB, descriptor, hubKeys, type Jwks, type JwksSource } from "./openaccess.ts";
import { HttpError, Store } from "./store.ts";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "site");

/** A request path to a file inside site/, or null if it escapes or is missing. */
function resolve(pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(site, clean);
  if (candidate !== site && !candidate.startsWith(site + sep)) return null;
  for (const target of [candidate, join(candidate, "index.html"), `${candidate}.html`]) {
    if (existsSync(target) && statSync(target).isFile()) return target;
  }
  return null;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8" };

export interface ServeOptions {
  port?: number;
  hostname?: string;
  db?: string;
  origin?: string;
  mail?: Mailer;
  hub?: string;
  jwks?: JwksSource & { refresh?: () => Promise<Jwks> };
}

export function serve(options: ServeOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const origin = new URL(options.origin ?? process.env.G1TZ_URL ?? `http://127.0.0.1:${port}`).origin;
  const store = new Store(options.db ?? process.env.G1TZ_DB ?? join(site, "..", "data", "g1tz.sqlite"));
  const mail = options.mail ?? mailer();
  const accounts = new Accounts(store, origin, mail);
  const api = createApi(store, mail, origin, accounts.cookieName);
  const hub = options.hub ?? process.env.OPENACCESS_HUB ?? DEFAULT_HUB;
  const keys = options.jwks ?? hubKeys(hub);
  const secure: Record<string, string> = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin" };
  const server = Bun.serve({
    port,
    hostname: options.hostname ?? "0.0.0.0",
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      // Railway overwrites X-Real-IP at the edge; never trust X-Forwarded-For.
      const ip = process.env.RAILWAY_ENVIRONMENT_ID
        ? request.headers.get("x-real-ip") || bunServer.requestIP(request)?.address || "unknown"
        : bunServer.requestIP(request)?.address || "unknown";
      if (url.pathname === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      if (url.pathname === "/.well-known/openaccess.json") {
        return Response.json(descriptor(origin, hub), { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
      }
      if (url.pathname === "/api/openaccess/webhook") {
        if (request.method !== "POST") return Response.json({ error: "POST the event." }, { status: 405 });
        try {
          const body = await request.text();
          if (body.length > 64 * 1024) throw new HttpError(413, "Event too large.");
          const result = await applyEntitlement(store, origin, body, request.headers.get("x-openaccess-signature"), keys);
          return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
        } catch (error) {
          if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
          console.error("webhook failed", error instanceof Error ? error.message : error);
          return Response.json({ error: "The event could not be applied." }, { status: 500 });
        }
      }
      const account = await accounts.handle(request, ip);
      if (account) return account;
      const apiResponse = await api(request, ip);
      if (apiResponse) return apiResponse;
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Not found." }, { status: 404 });

      if (url.pathname.length > 1 && url.pathname.endsWith("/")) return Response.redirect(`${origin}${url.pathname.slice(0, -1)}${url.search}`, 308);
      const file = resolve(url.pathname);
      if (!file) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain", ...secure } });
      const ext = file.slice(file.lastIndexOf("."));
      const page = url.pathname === "/account" || url.pathname === "/admin";
      return new Response(Bun.file(file), {
        headers: {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          "cache-control": page ? "no-store" : ext === ".html" ? "public, max-age=0, must-revalidate" : "public, max-age=300",
          ...secure,
          ...(page ? { "referrer-policy": "no-referrer" } : {}),
          ...(ext === ".html" ? { "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } : {}),
        },
      });
    },
  });
  return { server, store, accounts, origin, port: server.port, stop: () => { server.stop(true); store.close(); } };
}

if (import.meta.main) {
  const running = serve();
  console.log(`g1tz teams at ${running.origin} (listening on :${running.port})`);
}
