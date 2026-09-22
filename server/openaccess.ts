/**
 * OpenAccess: the plan is an entitlement.
 *
 * g1tz publishes an app descriptor at /.well-known/openaccess.json naming one
 * product per paid plan (`<host>/pro`, `<host>/advanced`, ...). The hub sells
 * them and tells us by a signed webhook when an entitlement changes; the
 * organization linked to that principal moves to the plan. Nothing here takes
 * money: a paid plan is a fact the hub reports, and a lapse reports itself.
 */
import { createPublicKey, verify } from "node:crypto";
import { HttpError, now, type Store } from "./store.ts";
import { isPlan, PLAN_SPECS, PLANS, type Plan } from "../src/teams-model.ts";

export const DEFAULT_HUB = "https://openaccess.logicsrc.com";

export interface Jwk { kty: string; crv?: string; x?: string; kid?: string; alg?: string; use?: string }
export interface Jwks { keys: Jwk[] }
export type JwksSource = () => Promise<Jwks>;

export function descriptor(origin: string, hub = DEFAULT_HUB) {
  const host = new URL(origin).host;
  return {
    openaccess: "0.1",
    app: origin,
    name: "g1tz",
    description: "A git TUI with organizations, roles, teams and shared workspaces.",
    scopes: {
      "teams:read": "See your organizations, members, teams and workspaces",
      "teams:manage": "Invite people, change roles, and manage teams and workspaces",
    },
    offers: PLANS.filter((plan) => plan !== "community").map((plan) => ({
      product: `${host}/${plan}`,
      name: `g1tz ${PLAN_SPECS[plan].name}`,
      description: PLAN_SPECS[plan].price,
      seats: PLAN_SPECS[plan].seatCap,
      links: {
        pay: `${origin}/pricing?plan=${plan}&principal={principal}`,
        manage: `${origin}/account`,
        cancel: `${origin}/account`,
        upgrade: `${origin}/pricing`,
      },
    })),
    honours: PLANS.filter((plan) => plan !== "community").map((plan) => `${host}/${plan}`),
    hubs: [hub],
    webhooks: { entitlements: `${origin}/api/openaccess/webhook` },
    operator: { name: "Profullstack, Inc.", url: "https://profullstack.com" },
  };
}

/** `<host>/<plan>` for this origin, or null for a product that is not ours. */
export function planForProduct(origin: string, product: unknown): Plan | null {
  if (typeof product !== "string") return null;
  const host = new URL(origin).host;
  const [productHost, plan] = product.split("/");
  return productHost === host && isPlan(plan) && plan !== "community" ? plan : null;
}

function decode(value: string): Buffer | null {
  try {
    return Buffer.from(value.trim(), value.includes("-") || value.includes("_") ? "base64url" : "base64");
  } catch {
    return null;
  }
}

/** Ed25519 over the raw body, header `X-OpenAccess-Signature: ed25519=<sig>`. */
export function verifySignature(body: string, header: string | null, jwks: Jwks): boolean {
  const match = header?.match(/^ed25519=(?:([\w-]+):)?([A-Za-z0-9+/_=-]+)$/);
  if (!match) return false;
  const [, kid, encoded] = match;
  const signature = decode(encoded!);
  if (!signature || signature.length !== 64) return false;
  for (const jwk of jwks.keys) {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) continue;
    if (kid && jwk.kid && jwk.kid !== kid) continue;
    try {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
      if (verify(null, Buffer.from(body), key, signature)) return true;
    } catch {
      /* a malformed key is skipped, not fatal */
    }
  }
  return false;
}

/** The hub's keys, cached, refreshed once when a signature fails. */
export function hubKeys(hub = DEFAULT_HUB, ttl = 10 * 60000): JwksSource & { refresh: () => Promise<Jwks> } {
  let cached: { keys: Jwks; at: number } | null = null;
  const fetchKeys = async (): Promise<Jwks> => {
    const response = await fetch(`${hub}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`jwks ${response.status}`);
    const keys = await response.json() as Jwks;
    if (!Array.isArray(keys.keys)) throw new Error("jwks has no keys");
    cached = { keys, at: Date.now() };
    return keys;
  };
  const source = async () => (cached && Date.now() - cached.at < ttl ? cached.keys : fetchKeys());
  return Object.assign(source, { refresh: fetchKeys });
}

interface EntitlementEvent {
  event?: string;
  type?: string;
  entitlement?: { principal?: string; product?: string; status?: string; quantity?: number; seats?: number; limits?: { seats?: number } };
}

const ACTIVE = new Set(["active", "granted", "trialing", "paid"]);
const GONE = new Set(["cancelled", "canceled", "expired", "revoked", "lapsed", "refunded", "inactive"]);

/**
 * Apply one entitlement event. Pure over the store, so tests can hand it a
 * body and a signature they made with their own key.
 */
export async function applyEntitlement(store: Store, origin: string, body: string, signature: string | null, keys: JwksSource & { refresh?: () => Promise<Jwks> }): Promise<{ status: number; body: Record<string, unknown> }> {
  let jwks = await keys();
  if (!verifySignature(body, signature, jwks)) {
    jwks = keys.refresh ? await keys.refresh() : jwks;
    if (!verifySignature(body, signature, jwks)) throw new HttpError(401, "Bad signature.");
  }
  let event: EntitlementEvent;
  try {
    event = JSON.parse(body);
    if (!event || typeof event !== "object") throw 0;
  } catch {
    throw new HttpError(400, "A JSON event is required.");
  }
  const name = String(event.event ?? event.type ?? "");
  if (!name.startsWith("entitlement.")) return { status: 200, body: { ok: true, ignored: name || "unnamed" } };
  const e = event.entitlement ?? {};
  const plan = planForProduct(origin, e.product);
  if (!plan) return { status: 200, body: { ok: true, ignored: "not our product", product: e.product ?? null } };
  if (typeof e.principal !== "string" || !e.principal) throw new HttpError(400, "The entitlement names no principal.");
  const org = store.get<{ id: string; name: string; plan: Plan; seats: number }>("SELECT id,name,plan,seats FROM organizations WHERE principal=?", e.principal);
  if (!org) return { status: 202, body: { ok: true, unlinked: e.principal, hint: "Link the principal to an organization: g1tz org link <orgId> <principal>" } };
  const status = String(e.status ?? (name.endsWith("cancel_requested") || name.endsWith("cancelled") || name.endsWith("revoked") ? "cancelled" : "active")).toLowerCase();
  const active = ACTIVE.has(status) || (!GONE.has(status) && name !== "entitlement.cancel_requested");
  const cap = PLAN_SPECS[plan].seatCap;
  const wanted = Number(e.seats ?? e.quantity ?? e.limits?.seats ?? cap ?? org.seats);
  const seats = Math.max(1, Number.isSafeInteger(wanted) ? (cap === null ? wanted : Math.min(wanted, cap)) : cap ?? 1);
  store.transaction(() => {
    if (active) store.run("UPDATE organizations SET plan=?,seats=? WHERE id=?", plan, seats, org.id);
    else store.run("UPDATE organizations SET plan='community',seats=1 WHERE id=?", org.id);
    store.run("INSERT INTO entitlements VALUES (?,?,?,?,?,?,?) ON CONFLICT(orgId) DO UPDATE SET product=excluded.product,principal=excluded.principal,status=excluded.status,seats=excluded.seats,source=excluded.source,updatedAt=excluded.updatedAt",
      org.id, e.product as string, e.principal as string, active ? "active" : status, active ? seats : null, "openaccess", now());
    store.audit(org.id, null, active ? "plan.entitled" : "plan.lapsed", plan, { from: org.plan, to: active ? plan : "community", seats: active ? seats : 1, event: name, status });
  });
  return { status: 200, body: { ok: true, orgId: org.id, plan: active ? plan : "community", seats: active ? seats : 1 } };
}
