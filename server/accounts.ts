/**
 * Sign-in. Two doors, one identity:
 *
 * - Browser: magic link. The address is the credential; a verified mailbox
 *   becomes a user and a 30-day cookie session.
 * - Terminal: device code. `g1tz login` asks for a code, prints it with a URL,
 *   and polls; the person approves it in a signed-in browser and the terminal
 *   receives a 90-day API token. The token is never typed or pasted.
 *
 * Under /api/auth/. Everything else is the operations API.
 */
import { checksum, email as parseEmail, HttpError, id, now, secret, Store, text, type User } from "./store.ts";
import type { Mailer } from "./mail.ts";

const SESSION_SECONDS = 30 * 86400;
const DEVICE_SECONDS = 600;
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

export class Accounts {
  cookieName: string;
  origin: string;
  constructor(public store: Store, origin: string, private mail: Mailer) {
    this.origin = new URL(origin).origin;
    this.cookieName = this.origin.startsWith("https:") ? "__Host-g1tz_session" : "g1tz_session";
  }
  rate(key: string, limit: number, seconds: number): void {
    const current = Date.now();
    this.store.run("DELETE FROM rate_limits WHERE expiresAt<=?", current);
    const row = this.store.get<{ count: number }>(
      "INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
      checksum(key), current + seconds * 1000)!;
    if (row.count > limit) throw new HttpError(429, "Too many attempts. Please try again later.");
  }
  cookie(token: string, age = SESSION_SECONDS): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  token(request: Request): string {
    return request.headers.get("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1) ?? "";
  }
  requireAccount(request: Request): User {
    const user = this.store.authenticate(this.token(request));
    if (!user) throw new HttpError(401, "Sign in with your email to continue.");
    return user;
  }

  // ------------------------------------------------------------ magic link

  private challenge(token: unknown): { email: string } {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, "This sign-in link is invalid or has expired. Request a new link.");
    const row = this.store.get<{ email: string }>("SELECT email FROM email_challenges WHERE tokenHash=? AND expiresAt>?", checksum(token), now());
    if (!row) throw new HttpError(400, "This sign-in link is invalid or has expired. Request a new link.");
    return row;
  }
  async requestLink(input: unknown, ip: string, next?: unknown) {
    this.rate(`send-ip:${ip}`, 20, 3600);
    const address = parseEmail(input);
    this.rate(`send-email-minute:${address}`, 1, 60);
    this.rate(`send-email-hour:${address}`, 5, 3600);
    const token = secret();
    this.store.run("DELETE FROM email_challenges WHERE expiresAt<=?", now());
    this.store.run("INSERT INTO email_challenges VALUES (?,?,?,?)", checksum(token), address, new Date(Date.now() + 15 * 60000).toISOString(), now());
    // Only a device code or an invitation may ride along, and only as a query
    // this site owns; the token itself stays in the fragment.
    const query = typeof next === "string" && /^[A-Z2-9-]{9}$/.test(next) ? `?device=${next}` : "";
    try {
      await this.mail.signIn({ to: address, url: `${this.origin}/account${query}#verify=${token}` });
    } catch {
      this.store.run("DELETE FROM email_challenges WHERE tokenHash=?", checksum(token));
      throw new HttpError(503, "We couldn't send your sign-in email. Please try again in a minute.");
    }
    return { ok: true, message: "Check your inbox for your sign-in link. It expires in 15 minutes.", retryAfter: 60 };
  }
  verify(token: unknown, oldToken: string): { user: User; session: string; joined: string[] } {
    return this.store.transaction(() => {
      const { email } = this.challenge(token);
      const user = this.store.ensureUser(email);
      const joined = this.store.autoJoin(user);
      this.store.ensureOrganization(user);
      this.store.run("DELETE FROM email_challenges WHERE email=?", email);
      this.store.run("DELETE FROM sessions WHERE tokenHash=? OR expiresAt<=?", checksum(oldToken), now());
      const session = this.store.session(user, "browser", "Email sign-in");
      return { user, session: session.token, joined };
    });
  }

  // ------------------------------------------------------------ device code

  /** Eight unambiguous characters as XXXX-XXXX. */
  private userCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let code = "";
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }
  static normalizeCode(value: unknown): string {
    const code = typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    if (code.length !== 8) throw new HttpError(400, "A device code is eight characters, XXXX-XXXX.");
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }
  deviceStart(label: unknown, ip: string) {
    this.rate(`device-start:${ip}`, 10, 60);
    this.store.run("DELETE FROM device_codes WHERE expiresAt<=?", now());
    const device = secret();
    let userCode = this.userCode();
    while (this.store.get("SELECT id FROM device_codes WHERE userCode=?", userCode)) userCode = this.userCode();
    const name = typeof label === "string" && label.trim() ? text(label, "Label", 80) : "g1tz";
    this.store.run("INSERT INTO device_codes (id,deviceHash,userCode,label,status,userId,expiresAt,createdAt) VALUES (?,?,?,?,'pending',NULL,?,?)",
      id(), checksum(device), userCode, name, new Date(Date.now() + DEVICE_SECONDS * 1000).toISOString(), now());
    return {
      device_code: device,
      user_code: userCode,
      verification_uri: `${this.origin}/account`,
      verification_uri_complete: `${this.origin}/account?device=${userCode}`,
      expires_in: DEVICE_SECONDS,
      interval: 3,
    };
  }
  /** The terminal asks until the person has decided. */
  devicePoll(device: unknown, ip: string): { status: number; body: Record<string, unknown> } {
    this.rate(`device-poll:${ip}`, 120, 60);
    if (typeof device !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(device)) return { status: 400, body: { error: "invalid_request" } };
    const row = this.store.get<{ id: string; status: string; userId: string | null; label: string; expiresAt: string }>(
      "SELECT id,status,userId,label,expiresAt FROM device_codes WHERE deviceHash=?", checksum(device));
    if (!row || row.expiresAt <= now()) return { status: 410, body: { error: "expired_token", message: "The code expired. Run g1tz login again." } };
    if (row.status === "denied") {
      this.store.run("DELETE FROM device_codes WHERE id=?", row.id);
      return { status: 403, body: { error: "access_denied", message: "The sign-in was denied in the browser." } };
    }
    if (row.status !== "approved" || !row.userId) return { status: 428, body: { error: "authorization_pending" } };
    const user = this.store.user(row.userId);
    const session = this.store.session(user, "device", row.label);
    this.store.run("DELETE FROM device_codes WHERE id=?", row.id);
    return { status: 200, body: { token: session.token, expiresAt: session.expiresAt, user: { id: user.id, displayName: user.displayName, email: user.email } } };
  }
  devicePreview(code: unknown) {
    const userCode = Accounts.normalizeCode(code);
    const row = this.store.get<{ label: string; createdAt: string; status: string }>("SELECT label,createdAt,status FROM device_codes WHERE userCode=? AND expiresAt>?", userCode, now());
    if (!row || row.status !== "pending") throw new HttpError(404, "That code is not waiting for approval. Run g1tz login again for a fresh one.");
    return { code: userCode, label: row.label, createdAt: row.createdAt };
  }
  deviceDecide(user: User, code: unknown, approve: boolean) {
    const userCode = Accounts.normalizeCode(code);
    const changed = this.store.run("UPDATE device_codes SET status=?,userId=? WHERE userCode=? AND status='pending' AND expiresAt>?",
      approve ? "approved" : "denied", approve ? user.id : null, userCode, now()).changes;
    if (!changed) throw new HttpError(404, "That code is not waiting for approval. Run g1tz login again for a fresh one.");
    return { ok: true, approved: approve };
  }

  // ------------------------------------------------------------ HTTP

  async handle(request: Request, ip = "unknown"): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/auth/")) return null;
    const reply = (body: unknown, status = 200, cookie?: string) => Response.json(body, { status, headers: {
      "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      ...(cookie ? { "set-cookie": cookie } : {}),
    } });
    try {
      if (request.method === "GET" && path === "/api/auth/session") return reply({ user: this.store.authenticate(this.token(request)) });
      if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
      const args = await json(request);
      // The device endpoints are called by a terminal with no Origin header
      // and no cookie: nothing here can be forged from another site.
      if (path === "/api/auth/device") return reply(this.deviceStart(args.label, ip));
      if (path === "/api/auth/device/token") {
        const result = this.devicePoll(args.device_code, ip);
        return reply(result.body, result.status);
      }
      if (request.headers.get("origin") !== this.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Please use the account page on this site.");
      if (path === "/api/auth/email") return reply(await this.requestLink(args.email, ip, args.next));
      if (path === "/api/auth/preview" || path === "/api/auth/verify") {
        this.rate(`verify:${ip}`, 60, 60);
        if (path.endsWith("preview")) return reply(this.challenge(args.token));
        const result = this.verify(args.token, this.token(request));
        return reply({ user: result.user, joined: result.joined }, 200, this.cookie(result.session));
      }
      if (path === "/api/auth/logout") {
        this.store.run("DELETE FROM sessions WHERE tokenHash=?", checksum(this.token(request)));
        return reply({ ok: true }, 200, this.cookie("", 0));
      }
      if (path === "/api/auth/logout-all") {
        const user = this.requireAccount(request);
        this.store.run("DELETE FROM sessions WHERE userId=?", user.id);
        return reply({ ok: true }, 200, this.cookie("", 0));
      }
      if (path === "/api/auth/profile") {
        const user = this.requireAccount(request);
        const name = text(args.displayName, "Name", 80);
        if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "Name must be between 1 and 80 characters.");
        this.store.run("UPDATE users SET displayName=? WHERE id=?", name, user.id);
        return reply({ user: this.store.user(user.id) });
      }
      if (path === "/api/auth/device/preview") return reply(this.devicePreview(args.code));
      if (path === "/api/auth/device/approve" || path === "/api/auth/device/deny") {
        const user = this.requireAccount(request);
        return reply(this.deviceDecide(user, args.code, path.endsWith("approve")));
      }
      return reply({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof HttpError) return reply({ error: error.message, ...error.details }, error.status);
      console.error("Account request failed", error instanceof Error ? error.name : "Unknown error");
      return reply({ error: "Something went wrong. Please try again." }, 500);
    }
  }
}

async function json(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send application/json.");
  const body = await request.text();
  if (body.length > 4096) throw new HttpError(413, "Request too large.");
  try {
    const args = JSON.parse(body);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
    return args;
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}
