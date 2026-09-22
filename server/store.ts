/**
 * The teams store: one SQLite file holding accounts, organizations, members,
 * teams, workspaces, invitations, entitlements and the audit log.
 *
 * Every rule that decides who may do what lives in ../src/teams-model.ts; this
 * file only asks it and reads or writes rows.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  can, consumesSeat, hasFeature, isPlan, isRole, planFor, seatUsage,
  type Action, type Feature, type Plan, type Role, type SeatUsage,
} from "../src/teams-model.ts";

export type User = { id: string; displayName: string; email: string; admin: number; createdAt: string };
export type Org = {
  id: string;
  name: string;
  plan: Plan;
  seats: number;
  ownerId: string;
  /** JSON array of verified email domains. */
  domains: string;
  /** The OpenAccess principal (`oa_…`) whose entitlements set the plan, when linked. */
  principal: string | null;
  createdAt: string;
};
export type Member = { orgId: string; userId: string; role: Role; createdAt: string };

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}
export const id = () => randomBytes(12).toString("base64url");
export const secret = () => randomBytes(32).toString("base64url");
export const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
export const equalSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(checksum(a)), Buffer.from(checksum(b)));
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `${name} must be 1–${max} characters.`);
  return value.trim();
}
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
export function email(value: unknown): string {
  const e = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (e.length > 254 || !EMAIL.test(e) || (e.split("@")[0] ?? "").length > 64) throw new HttpError(400, "Enter a valid email address.");
  return e;
}
export function role(value: unknown): Role {
  if (!isRole(value)) throw new HttpError(400, "Role must be owner, admin, lead, user or billing.");
  return value;
}
export function plan(value: unknown): Plan {
  if (!isPlan(value)) throw new HttpError(400, "Plan must be community, pro, advanced, business or enterprise.");
  return value;
}
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
export function domain(value: unknown): string {
  const d = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!DOMAIN.test(d) || d.length > 253) throw new HttpError(400, "Enter a domain such as example.com.");
  return d;
}

export class Store {
  db: Database;
  constructor(path: string | Database) {
    if (typeof path === "string") {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path, { create: true });
    } else this.db = path;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, displayName TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_emails (userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email TEXT UNIQUE NOT NULL COLLATE NOCASE, emailVerifiedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tokenHash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
      CREATE TABLE IF NOT EXISTS email_challenges (tokenHash TEXT PRIMARY KEY, email TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_codes (id TEXT PRIMARY KEY, deviceHash TEXT UNIQUE NOT NULL, userCode TEXT UNIQUE NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')), userId TEXT REFERENCES users(id) ON DELETE CASCADE, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'community', seats INTEGER NOT NULL DEFAULT 1, ownerId TEXT NOT NULL REFERENCES users(id), domains TEXT NOT NULL DEFAULT '[]', principal TEXT UNIQUE, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','admin','lead','user','billing')), createdAt TEXT NOT NULL, PRIMARY KEY(orgId,userId));
      CREATE INDEX IF NOT EXISTS members_user ON members(userId);
      CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, name TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(orgId,name));
      CREATE TABLE IF NOT EXISTS team_members (teamId TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(teamId,userId));
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL, teamId TEXT REFERENCES teams(id) ON DELETE SET NULL, tokenHash TEXT UNIQUE NOT NULL, invitedBy TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(orgId,email));
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, teamId TEXT REFERENCES teams(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspaces_org ON workspaces(orgId);
      CREATE TABLE IF NOT EXISTS workspace_repos (workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, url TEXT NOT NULL, name TEXT NOT NULL, addedBy TEXT NOT NULL, addedAt TEXT NOT NULL, PRIMARY KEY(workspaceId,url));
      CREATE TABLE IF NOT EXISTS entitlements (orgId TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE, product TEXT NOT NULL, principal TEXT NOT NULL, status TEXT NOT NULL, seats INTEGER, source TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, actorId TEXT, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_org ON audit(orgId,seq);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  get<T>(sql: string, ...args: (string | number | null)[]): T | null {
    return this.db.query(sql).get(...args) as T | null;
  }
  all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.query(sql).all(...args) as T[];
  }
  run(sql: string, ...args: (string | number | null)[]) {
    return this.db.query(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ------------------------------------------------------------ accounts

  user(userId: string): User {
    const u = this.get<User>("SELECT u.id,u.displayName,u.admin,u.createdAt,e.email FROM users u JOIN account_emails e ON e.userId=u.id WHERE u.id=?", userId);
    if (!u) throw new HttpError(401, "Sign in to continue.");
    return u;
  }
  userByEmail(address: string): User | null {
    const row = this.get<{ userId: string }>("SELECT userId FROM account_emails WHERE email=?", address);
    return row ? this.user(row.userId) : null;
  }
  /** Only verified, unexpired sessions count. */
  authenticate(token: string): User | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.get<{ userId: string }>(
      "SELECT s.userId FROM sessions s JOIN account_emails e ON e.userId=s.userId WHERE s.tokenHash=? AND s.expiresAt>?",
      checksum(token), now());
    return session ? this.user(session.userId) : null;
  }
  session(user: { id: string }, kind: "browser" | "api" | "device" = "browser", label = "Browser session") {
    const token = secret();
    const sessionId = id();
    const days = kind === "browser" ? 30 : 90;
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    this.run("DELETE FROM sessions WHERE expiresAt<=?", now());
    this.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)", sessionId, user.id, checksum(token), kind, label, expiresAt, now());
    return { id: sessionId, token, expiresAt, label, kind };
  }
  /** A verified address becomes a user, once. */
  ensureUser(address: string): User {
    const existing = this.userByEmail(address);
    if (existing) return existing;
    const userId = id();
    this.run("INSERT INTO users (id,displayName,admin,createdAt) VALUES (?,?,0,?)", userId, address.split("@")[0] ?? address, now());
    this.run("INSERT INTO account_emails VALUES (?,?,?)", userId, address, now());
    return this.user(userId);
  }
  /**
   * A signed-in user with no organization gets a personal one, on the free
   * plan, so the Team screen has something to show and an upgrade has a home.
   */
  ensureOrganization(user: User): Org {
    const existing = this.get<{ orgId: string }>("SELECT orgId FROM members WHERE userId=? ORDER BY createdAt LIMIT 1", user.id);
    if (existing) return this.org(existing.orgId);
    return this.createOrganization(user, `${user.displayName}'s organization`);
  }
  createOrganization(user: User, name: string): Org {
    const orgId = id();
    this.transaction(() => {
      this.run("INSERT INTO organizations (id,name,plan,seats,ownerId,domains,principal,createdAt) VALUES (?,?,'community',1,?,'[]',NULL,?)", orgId, name, user.id, now());
      this.run("INSERT INTO members VALUES (?,?,'owner',?)", orgId, user.id, now());
      this.audit(orgId, user.id, "organization.create", orgId, { name });
    });
    return this.org(orgId);
  }
  /**
   * Verified email domains: a new sign-in whose domain an organization has
   * verified joins it as a User, when a seat is free. Returns the organizations
   * joined.
   */
  autoJoin(user: User): string[] {
    const at = user.email.split("@")[1];
    if (!at) return [];
    const joined: string[] = [];
    for (const org of this.all<Org>("SELECT * FROM organizations WHERE domains!='[]'")) {
      const domains = JSON.parse(org.domains) as string[];
      const allowed = hasFeature(org.plan, "sso.domains") ? domains : hasFeature(org.plan, "sso.domain") ? domains.slice(0, 1) : [];
      if (!allowed.includes(at)) continue;
      if (this.get("SELECT userId FROM members WHERE orgId=? AND userId=?", org.id, user.id)) continue;
      if (this.seats(org).free < 1) continue;
      this.run("INSERT INTO members VALUES (?,?,'user',?)", org.id, user.id, now());
      this.run("DELETE FROM invitations WHERE orgId=? AND email=?", org.id, user.email);
      this.audit(org.id, user.id, "member.join", user.id, { via: "domain", domain: at, role: "user" });
      joined.push(org.id);
    }
    return joined;
  }

  // ------------------------------------------------------------ organizations

  org(orgId: string): Org {
    const org = this.get<Org>("SELECT * FROM organizations WHERE id=?", orgId);
    if (!org) throw new HttpError(404, "Organization not found.");
    return org;
  }
  orgRole(user: User, orgId: string): Role | undefined {
    if (user.admin && this.get("SELECT id FROM organizations WHERE id=?", orgId)) return "owner";
    return this.get<{ role: Role }>("SELECT role FROM members WHERE orgId=? AND userId=?", orgId, user.id)?.role;
  }
  /** Membership of any role. */
  member(user: User, orgId: string): { org: Org; role: Role } {
    const org = this.org(orgId);
    const role = this.orgRole(user, orgId);
    if (!role) throw new HttpError(403, "You are not a member of this organization.");
    return { org, role };
  }
  /** Membership with a role that may take the action. */
  require(user: User, orgId: string, action: Action): { org: Org; role: Role } {
    const found = this.member(user, orgId);
    if (!can(found.role, action)) throw new HttpError(403, `${ACTION_LINES[action]} needs the ${NEEDS[action]} role; you are ${found.role === "billing" ? "the Billing Contact" : `a${found.role === "owner" || found.role === "admin" ? "n" : ""} ${found.role}`}.`);
    return found;
  }
  /** 402 with the plan that unlocks it, so a client can say "needs Pro". */
  requireFeature(org: Org, feature: Feature): void {
    if (hasFeature(org.plan, feature)) return;
    const needed = planFor(feature);
    throw new HttpError(402, `${FEATURE_LINE[feature]} needs the ${needed[0]!.toUpperCase()}${needed.slice(1)} plan; ${org.name} is on ${org.plan[0]!.toUpperCase()}${org.plan.slice(1)}.`, { feature, plan: needed, current: org.plan });
  }
  members(orgId: string): (Member & { displayName: string; email: string })[] {
    return this.all("SELECT m.orgId,m.userId,m.role,m.createdAt,u.displayName,e.email FROM members m JOIN users u ON u.id=m.userId JOIN account_emails e ON e.userId=u.id WHERE m.orgId=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'lead' THEN 2 WHEN 'user' THEN 3 ELSE 4 END, e.email", orgId);
  }
  invitations(orgId: string) {
    return this.all<{ id: string; email: string; role: Role; teamId: string | null; invitedBy: string; expiresAt: string; createdAt: string }>(
      "SELECT id,email,role,teamId,invitedBy,expiresAt,createdAt FROM invitations WHERE orgId=? AND expiresAt>? ORDER BY createdAt", orgId, now());
  }
  seats(org: Org): SeatUsage {
    return seatUsage(org.plan, org.seats, this.members(org.id), this.invitations(org.id));
  }
  /** Adding a member or an invitation with this role must fit the seats. */
  requireSeat(org: Org, forRole: Role): void {
    if (!consumesSeat(forRole)) return;
    const usage = this.seats(org);
    if (usage.free >= 1) return;
    throw new HttpError(409, usage.cap !== null && usage.seats >= usage.cap
      ? `${org.name} is using every seat the ${org.plan} plan allows (${usage.cap}). Upgrade the plan to add people.`
      : `${org.name} has no free seat (${usage.used} in use, ${usage.pending} invited, ${usage.seats} seats). Add seats or remove someone.`,
      { seats: usage });
  }
  audit(orgId: string, actorId: string | null, action: string, target = "", details: Record<string, unknown> = {}): void {
    this.run("INSERT INTO audit (id,orgId,actorId,action,target,details,at) VALUES (?,?,?,?,?,?,?)", id(), orgId, actorId, action, target, JSON.stringify(details), now());
  }
  close() {
    this.db.close();
  }
}

const ACTION_LINES: Record<Action, string> = {
  manageUsers: "Managing users",
  manageTeams: "Managing teams",
  manageWorkspaces: "Managing workspaces",
  billing: "Billing",
  insights: "Insights",
  audit: "The audit log",
  transferOwnership: "Transferring ownership",
};
const NEEDS: Record<Action, string> = {
  manageUsers: "Owner or Admin",
  manageTeams: "Owner, Admin or Lead",
  manageWorkspaces: "Owner, Admin or Lead",
  billing: "Owner, Admin or Billing Contact",
  insights: "Owner, Admin or Lead",
  audit: "Owner or Admin",
  transferOwnership: "Owner",
};
const FEATURE_LINE: Record<Feature, string> = {
  "members.invite": "Inviting people",
  "workspaces.shared": "A shared workspace",
  "teams": "Teams",
  "sso.domain": "A verified domain",
  "sso.domains": "More than one verified domain",
  "insights": "Insights",
  "audit.export": "Audit export",
  "support.sla": "A support SLA",
};
