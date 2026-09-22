/**
 * A running server on a random port, an in-memory database, a mailer that
 * keeps every message, and a hub key the tests hold the private half of.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer } from "node:net";
import { serve } from "../server.ts";
import type { InviteMail, Mailer, SignInMail } from "../mail.ts";
import type { Jwks } from "../openaccess.ts";

export interface Harness {
  origin: string;
  mails: { signIn: SignInMail[]; invites: InviteMail[] };
  jwks: Jwks;
  privateKey: KeyObject;
  sign: (body: string) => string;
  stop: () => void;
  /** Sign in a mailbox through the magic link; returns a cookie client. */
  signIn: (email: string) => Promise<Client>;
  /** A bearer client for a token. */
  bearer: (token: string) => Client;
  anonymous: () => Client;
}

export interface Client {
  origin: string;
  headers: Record<string, string>;
  /** POST /api/v1/actions; throws an Error carrying status and body on failure. */
  call: <T = Record<string, unknown>>(operation: string, args?: Record<string, unknown>) => Promise<T>;
  /** Any request with this identity, same-origin. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** POST JSON to /api/auth/... */
  auth: (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown>; cookie?: string }>;
}

export class ApiFailure extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body.error ?? `HTTP ${status}`));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export async function harness(env: Record<string, string> = {}): Promise<Harness> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mails: Harness["mails"] = { signIn: [], invites: [] };
  const mail: Mailer = {
    signIn: async (m) => { if (m.to.endsWith("@bounce.test")) throw new Error("bounce"); mails.signIn.push(m); },
    invite: async (m) => { if (m.to.endsWith("@bounce.test")) throw new Error("bounce"); mails.invites.push(m); },
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  const jwks: Jwks = { keys: [{ ...jwk, kid: "test-1", alg: "EdDSA", use: "sig" }] };
  // The server needs its origin before it listens, so pick a free port first.
  const port = await freePort();
  const real = serve({ port, hostname: "127.0.0.1", db: ":memory:", mail, jwks: async () => jwks, origin: `http://127.0.0.1:${port}` });
  const finalOrigin = `http://127.0.0.1:${real.port}`;

  const client = (headers: Record<string, string>): Client => {
    const c: Client = {
      origin: finalOrigin,
      headers,
      fetch: (path, init = {}) => fetch(`${finalOrigin}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }),
      call: async (operation, args = {}) => {
        const response = await c.fetch("/api/v1/actions", { method: "POST", headers: { "content-type": "application/json", origin: finalOrigin }, body: JSON.stringify({ operation, args }) });
        const body = await response.json() as Record<string, unknown>;
        if (!response.ok) throw new ApiFailure(response.status, body);
        return body as never;
      },
      auth: async (path, body) => {
        const response = await c.fetch(`/api/auth/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: finalOrigin }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as Record<string, unknown>, cookie: response.headers.get("set-cookie") ?? undefined };
      },
    };
    return c;
  };
  const anonymous = () => client({});
  const signIn = async (email: string): Promise<Client> => {
    const before = mails.signIn.length;
    const sent = await anonymous().auth("email", { email });
    if (sent.status !== 200) throw new Error(`sign-in mail refused: ${sent.status} ${JSON.stringify(sent.body)}`);
    const url = mails.signIn[before]?.url ?? "";
    const token = url.split("#verify=")[1];
    const verified = await anonymous().auth("verify", { token });
    if (verified.status !== 200 || !verified.cookie) throw new Error(`verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
    return client({ cookie: verified.cookie.split(";")[0]! });
  };
  return {
    origin: finalOrigin,
    mails,
    jwks,
    privateKey,
    sign: (body) => `ed25519=${sign(null, Buffer.from(body), privateKey).toString("base64")}`,
    stop: () => real.stop(),
    signIn,
    bearer: (token) => client({ authorization: `Bearer ${token}` }),
    anonymous,
  };
}

/** Make `client` the site administrator through the bootstrap secret. */
export async function makeAdmin(client: Client): Promise<void> {
  process.env.G1TZ_ADMIN_BOOTSTRAP_SECRET = process.env.G1TZ_ADMIN_BOOTSTRAP_SECRET || "bootstrap-secret";
  await client.call("admin_claim", { token: process.env.G1TZ_ADMIN_BOOTSTRAP_SECRET });
}

/** The caller's first (personal) organization. */
export async function firstOrg(client: Client): Promise<{ id: string; name: string; plan: string; role: string }> {
  const orgs = await client.call<{ id: string; name: string; plan: string; role: string }[]>("organizations_list");
  if (!orgs[0]) throw new Error("no organization");
  return orgs[0];
}

export async function fails(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiFailure) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}
