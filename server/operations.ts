/**
 * Every action a signed-in person can take, by name, with one argument object.
 * The HTTP layer, the CLI, the Team screen and the account page all speak
 * this vocabulary, so a permission checked here is checked everywhere.
 */
import {
  checksum, domain as parseDomain, email as parseEmail, HttpError, id, now, plan as parsePlan, role as parseRole, secret, text,
  type Org, type Store, type User,
} from "./store.ts";
import type { Mailer } from "./mail.ts";
import {
  atLeast, consumesSeat, entitlements, hasFeature, PLAN_SPECS, PLANS, ROLES, seatUsage,
  type Plan, type Role,
} from "../src/teams-model.ts";

type Args = Record<string, unknown>;
const key = (args: Args, name: string) => text(args[name], name);
const PRINCIPAL = /^oa_[A-Za-z0-9_-]{6,120}$/;
/** Public mailboxes cannot be an organization's verified domain. */
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "mail.com", "gmx.com", "fastmail.com", "hey.com", "yandex.com", "qq.com"]);
const capital = (value: string) => `${value[0]!.toUpperCase()}${value.slice(1)}`;

export interface Context {
  store: Store;
  user: User;
  origin: string;
  mail: Mailer;
}

function page(args: Args): [number, number] {
  const limit = Number(args.limit ?? 200), offset = Number(args.offset ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "Use limit 1–1000 and a nonnegative offset.");
  return [limit, offset];
}

/** Excel-safe CSV: quote everything, neutralise a leading formula character. */
export function csv(rows: readonly (readonly (string | number | null)[])[]): string {
  return rows.map((row) => row.map((cell) => {
    let value = cell === null ? "" : String(cell);
    if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
    return `"${value.replace(/"/g, '""')}"`;
  }).join(",")).join("\r\n") + "\r\n";
}
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function orgSummary(store: Store, org: Org, role: Role) {
  const usage = store.seats(org);
  return {
    id: org.id,
    name: org.name,
    plan: org.plan,
    planName: PLAN_SPECS[org.plan].name,
    role,
    ownerId: org.ownerId,
    seats: usage,
    domains: JSON.parse(org.domains) as string[],
    principal: org.principal,
    createdAt: org.createdAt,
  };
}

export async function operate(ctx: Context, operation: string, args: Args): Promise<unknown> {
  const { store, user, origin } = ctx;
  const orgId = () => key(args, "orgId");
  const audit = (org: Org, action: string, target = "", details: Record<string, unknown> = {}) => store.audit(org.id, user.id, action, target, details);
  const team = (action: "manageTeams" | "member" = "manageTeams") => {
    const t = store.get<{ id: string; orgId: string; name: string }>("SELECT * FROM teams WHERE id=?", key(args, "teamId"));
    if (!t) throw new HttpError(404, "Team not found.");
    const found = action === "member" ? store.member(user, t.orgId) : store.require(user, t.orgId, action);
    return { ...found, team: t };
  };
  const workspace = (write: boolean) => {
    const w = store.get<{ id: string; orgId: string; teamId: string | null; name: string; description: string; createdBy: string; createdAt: string; updatedAt: string }>(
      "SELECT * FROM workspaces WHERE id=?", key(args, "workspaceId"));
    if (!w) throw new HttpError(404, "Workspace not found.");
    const found = write ? store.require(user, w.orgId, "manageWorkspaces") : store.member(user, w.orgId);
    const inTeam = !w.teamId || found.role === "owner" || found.role === "admin" || !!store.get("SELECT userId FROM team_members WHERE teamId=? AND userId=?", w.teamId, user.id);
    if (!inTeam) throw new HttpError(404, "Workspace not found.");
    return { ...found, workspace: w };
  };
  const repos = (workspaceId: string) => store.all<{ url: string; name: string; addedBy: string; addedAt: string }>(
    "SELECT url,name,addedBy,addedAt FROM workspace_repos WHERE workspaceId=? ORDER BY name", workspaceId);
  const targetUser = () => {
    if (typeof args.email === "string") {
      const found = store.userByEmail(parseEmail(args.email));
      if (!found) throw new HttpError(404, "No account has that email.");
      return found;
    }
    return store.user(key(args, "userId"));
  };
  /** The Lead role exists on plans that have Insights. */
  const roleAllowed = (org: Org, r: Role) => {
    if (r === "owner") throw new HttpError(400, "There is one owner. Transfer ownership instead.");
    if (r === "lead") store.requireFeature(org, "insights");
  };

  switch (operation) {
    // ---------------------------------------------------------- account
    case "account_me":
      return {
        ...user,
        organizations: store.all<{ id: string; name: string; plan: Plan; role: Role }>(
          "SELECT o.id,o.name,o.plan,m.role FROM organizations o JOIN members m ON m.orgId=o.id WHERE m.userId=? ORDER BY o.createdAt", user.id),
        invitations: store.all("SELECT i.id,i.role,i.expiresAt,o.id AS orgId,o.name AS organization FROM invitations i JOIN organizations o ON o.id=i.orgId WHERE i.email=? AND i.expiresAt>?", user.email, now()),
      };

    // ---------------------------------------------------------- organizations
    case "organizations_list":
      return store.all<Org & { role: Role }>(
        user.admin ? "SELECT o.*,'owner' AS role FROM organizations o ORDER BY o.createdAt"
          : "SELECT o.*,m.role FROM organizations o JOIN members m ON m.orgId=o.id WHERE m.userId=? ORDER BY o.createdAt",
        ...(user.admin ? [] : [user.id]),
      ).map((row) => orgSummary(store, row, row.role));
    case "organizations_create": {
      const name = text(args.name, "Organization name", 120);
      if (store.get<{ count: number }>("SELECT COUNT(*) AS count FROM organizations WHERE ownerId=?", user.id)!.count >= 20) throw new HttpError(413, "You already own 20 organizations.");
      const org = store.createOrganization(user, name);
      return orgSummary(store, org, "owner");
    }
    case "organizations_get": {
      const { org, role } = store.member(user, orgId());
      const counts = {
        members: store.get<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE orgId=?", org.id)!.n,
        invitations: store.invitations(org.id).length,
        teams: store.get<{ n: number }>("SELECT COUNT(*) AS n FROM teams WHERE orgId=?", org.id)!.n,
        workspaces: store.get<{ n: number }>("SELECT COUNT(*) AS n FROM workspaces WHERE orgId=?", org.id)!.n,
      };
      return { ...orgSummary(store, org, role), counts, entitlements: entitlements(org.plan), entitlement: store.get("SELECT product,principal,status,seats,source,updatedAt FROM entitlements WHERE orgId=?", org.id) };
    }
    case "organizations_update": {
      const { org } = store.require(user, orgId(), "manageUsers");
      const name = text(args.name, "Organization name", 120);
      store.run("UPDATE organizations SET name=? WHERE id=?", name, org.id);
      audit(org, "organization.rename", org.id, { from: org.name, to: name });
      return { ok: true };
    }
    case "organizations_delete": {
      const { org } = store.require(user, orgId(), "transferOwnership");
      if (args.confirm !== org.name) throw new HttpError(428, `Send confirm: "${org.name}" to delete it and everything in it.`);
      store.run("DELETE FROM organizations WHERE id=?", org.id);
      return { ok: true };
    }
    case "organizations_transfer": {
      const { org } = store.require(user, orgId(), "transferOwnership");
      const next = targetUser();
      if (next.id === org.ownerId) throw new HttpError(400, "That person already owns the organization.");
      const current = store.get<{ role: Role }>("SELECT role FROM members WHERE orgId=? AND userId=?", org.id, next.id);
      if (!current) throw new HttpError(400, "Add this person to the organization first.");
      if (!consumesSeat(current.role)) store.requireSeat(org, "owner");
      store.transaction(() => {
        store.run("UPDATE members SET role='admin' WHERE orgId=? AND userId=?", org.id, org.ownerId);
        store.run("UPDATE members SET role='owner' WHERE orgId=? AND userId=?", org.id, next.id);
        store.run("UPDATE organizations SET ownerId=? WHERE id=?", next.id, org.id);
        audit(org, "organization.transfer", next.id, { from: org.ownerId, to: next.id });
      });
      return { ok: true, ownerId: next.id };
    }
    case "organizations_link": {
      const { org } = store.require(user, orgId(), "billing");
      const principal = args.principal === null ? null : key(args, "principal");
      if (principal && !PRINCIPAL.test(principal)) throw new HttpError(400, "An OpenAccess principal looks like oa_….");
      if (principal && store.get("SELECT id FROM organizations WHERE principal=? AND id!=?", principal, org.id)) throw new HttpError(409, "That principal is linked to another organization.");
      store.run("UPDATE organizations SET principal=? WHERE id=?", principal, org.id);
      audit(org, "organization.link", principal ?? "", { principal });
      return { ok: true, principal };
    }
    case "domains_set": {
      const { org } = store.require(user, orgId(), "manageUsers");
      if (!Array.isArray(args.domains) || args.domains.length > 50) throw new HttpError(400, "domains must be a list.");
      const domains = [...new Set(args.domains.map(parseDomain))];
      if (domains.length) store.requireFeature(org, "sso.domain");
      if (domains.length > 1) store.requireFeature(org, "sso.domains");
      const admins = store.members(org.id).filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.email.split("@")[1]);
      for (const d of domains) {
        if (PUBLIC_MAIL.has(d)) throw new HttpError(400, `${d} is a public mail provider; anyone could join.`);
        if (!admins.includes(d)) throw new HttpError(400, `Verify ${d} by having an Owner or Admin sign in with an @${d} address first.`);
      }
      store.run("UPDATE organizations SET domains=? WHERE id=?", JSON.stringify(domains), org.id);
      audit(org, "domains.set", "", { domains });
      return { ok: true, domains };
    }

    // ---------------------------------------------------------- members
    case "members_list": {
      const { org, role } = store.member(user, orgId());
      const teams = store.all<{ userId: string; teamId: string; name: string }>("SELECT tm.userId,t.id AS teamId,t.name FROM team_members tm JOIN teams t ON t.id=tm.teamId WHERE t.orgId=?", org.id);
      return {
        members: store.members(org.id).map((m) => ({ ...m, teams: teams.filter((t) => t.userId === m.userId).map((t) => ({ id: t.teamId, name: t.name })) })),
        invitations: role === "owner" || role === "admin" ? store.invitations(org.id) : [],
        seats: store.seats(org),
      };
    }
    case "members_invite": {
      const { org } = store.require(user, orgId(), "manageUsers");
      store.requireFeature(org, "members.invite");
      const address = parseEmail(args.email);
      const r = parseRole(args.role ?? "user");
      roleAllowed(org, r);
      const teamId = args.teamId ? key(args, "teamId") : null;
      if (teamId) {
        store.requireFeature(org, "teams");
        if (!store.get("SELECT id FROM teams WHERE id=? AND orgId=?", teamId, org.id)) throw new HttpError(400, "Team must belong to this organization.");
      }
      const existing = store.userByEmail(address);
      if (existing && store.get("SELECT userId FROM members WHERE orgId=? AND userId=?", org.id, existing.id)) throw new HttpError(409, `${address} is already a member.`);
      store.run("DELETE FROM invitations WHERE orgId=? AND email=?", org.id, address);
      store.requireSeat(org, r);
      const token = secret();
      const inviteId = id();
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      store.run("INSERT INTO invitations VALUES (?,?,?,?,?,?,?,?,?)", inviteId, org.id, address, r, teamId, checksum(token), user.id, expiresAt, now());
      const url = `${origin}/account#invite=${token}`;
      try {
        await ctx.mail.invite({ to: address, url, org: org.name, inviter: user.displayName, role: r });
      } catch {
        store.run("DELETE FROM invitations WHERE id=?", inviteId);
        throw new HttpError(503, "The invitation email could not be sent. Try again in a minute.");
      }
      audit(org, "member.invite", address, { role: r, teamId });
      return { id: inviteId, email: address, role: r, teamId, expiresAt, url };
    }
    case "members_update": {
      const { org } = store.require(user, orgId(), "manageUsers");
      const target = targetUser();
      const current = store.get<{ role: Role }>("SELECT role FROM members WHERE orgId=? AND userId=?", org.id, target.id);
      if (!current) throw new HttpError(404, "Member not found.");
      if (current.role === "owner") throw new HttpError(409, "The owner's role only changes by transferring ownership.");
      const r = parseRole(args.role);
      roleAllowed(org, r);
      if (r === current.role) return { ok: true, role: r };
      if (consumesSeat(r) && !consumesSeat(current.role)) store.requireSeat(org, r);
      store.run("UPDATE members SET role=? WHERE orgId=? AND userId=?", r, org.id, target.id);
      audit(org, "member.role", target.id, { email: target.email, from: current.role, to: r });
      return { ok: true, role: r };
    }
    case "members_remove":
    case "members_leave": {
      const leaving = operation === "members_leave";
      const { org } = leaving ? store.member(user, orgId()) : store.require(user, orgId(), "manageUsers");
      const target = leaving ? user : targetUser();
      const current = store.get<{ role: Role }>("SELECT role FROM members WHERE orgId=? AND userId=?", org.id, target.id);
      if (!current) throw new HttpError(404, "Member not found.");
      if (current.role === "owner") throw new HttpError(409, leaving ? "Transfer ownership before leaving." : "The owner cannot be removed. Transfer ownership first.");
      store.transaction(() => {
        store.run("DELETE FROM team_members WHERE userId=? AND teamId IN (SELECT id FROM teams WHERE orgId=?)", target.id, org.id);
        store.run("DELETE FROM members WHERE orgId=? AND userId=?", org.id, target.id);
        audit(org, leaving ? "member.leave" : "member.remove", target.id, { email: target.email, role: current.role });
      });
      return { ok: true };
    }
    case "members_export": {
      const { org } = store.require(user, orgId(), "manageUsers");
      const rows: (string | null)[][] = [["email", "name", "role", "seat", "teams", "since"]];
      const teams = store.all<{ userId: string; name: string }>("SELECT tm.userId,t.name FROM team_members tm JOIN teams t ON t.id=tm.teamId WHERE t.orgId=? ORDER BY t.name", org.id);
      for (const m of store.members(org.id)) rows.push([m.email, m.displayName, m.role, consumesSeat(m.role) ? "yes" : "no", teams.filter((t) => t.userId === m.userId).map((t) => t.name).join("; "), m.createdAt]);
      for (const i of store.invitations(org.id)) rows.push([i.email, "", i.role, consumesSeat(i.role) ? "invited" : "no", "", i.createdAt]);
      return { csv: csv(rows), filename: `${org.name.replace(/[^\w.-]+/g, "_")}-members.csv` };
    }
    case "members_import": {
      const { org } = store.require(user, orgId(), "manageUsers");
      store.requireFeature(org, "members.invite");
      const source = typeof args.csv === "string" ? args.csv : "";
      if (Buffer.byteLength(source) > 1024 * 1024) throw new HttpError(413, "CSV is limited to 1 MB.");
      const rows = parseCsv(source);
      const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
      const at = (name: string) => header.indexOf(name);
      if (at("email") < 0) throw new HttpError(400, "The CSV needs an email column (email, role, team).");
      const results: { email: string; ok: boolean; message: string }[] = [];
      for (const row of rows.slice(1)) {
        const address = row[at("email")] ?? "";
        const r = (at("role") >= 0 ? row[at("role")] : "") || "user";
        const teamName = at("team") >= 0 ? (row[at("team")] ?? "").trim() : "";
        try {
          let teamId: string | undefined;
          if (teamName) {
            store.requireFeature(org, "teams");
            const t = store.get<{ id: string }>("SELECT id FROM teams WHERE orgId=? AND name=?", org.id, teamName);
            if (!t) {
              store.require(user, org.id, "manageTeams");
              teamId = id();
              store.run("INSERT INTO teams VALUES (?,?,?,?)", teamId, org.id, text(teamName, "Team name", 80), now());
              audit(org, "team.create", teamId, { name: teamName, via: "import" });
            } else teamId = t.id;
          }
          const invited = await operate(ctx, "members_invite", { orgId: org.id, email: address, role: r.trim().toLowerCase(), teamId }) as { email: string };
          results.push({ email: invited.email, ok: true, message: "invited" });
        } catch (error) {
          results.push({ email: address, ok: false, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return { results, invited: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    }

    // ---------------------------------------------------------- invitations
    case "invitations_list":
      return store.invitations(store.require(user, orgId(), "manageUsers").org.id);
    case "invitations_revoke": {
      const { org } = store.require(user, orgId(), "manageUsers");
      const invite = store.get<{ email: string }>("SELECT email FROM invitations WHERE id=? AND orgId=?", key(args, "invitationId"), org.id);
      if (!invite) throw new HttpError(404, "Invitation not found.");
      store.run("DELETE FROM invitations WHERE id=? AND orgId=?", key(args, "invitationId"), org.id);
      audit(org, "member.invite.revoke", invite.email);
      return { ok: true };
    }
    case "invitations_accept":
      return store.transaction(() => {
        const invite = typeof args.token === "string"
          ? store.get<{ id: string; orgId: string; email: string; role: Role; teamId: string | null }>("SELECT * FROM invitations WHERE tokenHash=? AND expiresAt>?", checksum(args.token), now())
          : store.get<{ id: string; orgId: string; email: string; role: Role; teamId: string | null }>("SELECT * FROM invitations WHERE id=? AND expiresAt>?", key(args, "invitationId"), now());
        if (!invite) throw new HttpError(404, "The invitation has expired or was already used.");
        if (invite.email.toLowerCase() !== user.email.toLowerCase()) throw new HttpError(403, `This invitation was sent to ${invite.email}. Sign in with that address to accept it.`);
        const org = store.org(invite.orgId);
        if (!store.get("SELECT userId FROM members WHERE orgId=? AND userId=?", org.id, user.id)) {
          store.run("INSERT INTO members VALUES (?,?,?,?)", org.id, user.id, invite.role, now());
        }
        if (invite.teamId) store.run("INSERT OR IGNORE INTO team_members VALUES (?,?)", invite.teamId, user.id);
        store.run("DELETE FROM invitations WHERE id=?", invite.id);
        audit(org, "member.join", user.id, { via: "invitation", role: invite.role, teamId: invite.teamId });
        return { orgId: org.id, organization: org.name, role: invite.role };
      });

    // ---------------------------------------------------------- teams
    case "teams_list": {
      const { org } = store.member(user, orgId());
      const teams = store.all<{ id: string; name: string; createdAt: string }>("SELECT id,name,createdAt FROM teams WHERE orgId=? ORDER BY name", org.id);
      const counts = store.all<{ teamId: string; n: number }>("SELECT teamId,COUNT(*) AS n FROM team_members WHERE teamId IN (SELECT id FROM teams WHERE orgId=?) GROUP BY teamId", org.id);
      const mine = new Set(store.all<{ teamId: string }>("SELECT teamId FROM team_members WHERE userId=?", user.id).map((r) => r.teamId));
      return teams.map((t) => ({ ...t, members: counts.find((c) => c.teamId === t.id)?.n ?? 0, member: mine.has(t.id) }));
    }
    case "teams_create": {
      const { org } = store.require(user, orgId(), "manageTeams");
      store.requireFeature(org, "teams");
      const name = text(args.name, "Team name", 80);
      if (store.get("SELECT id FROM teams WHERE orgId=? AND name=?", org.id, name)) throw new HttpError(409, `There is already a team called ${name}.`);
      const teamId = id();
      store.transaction(() => {
        store.run("INSERT INTO teams VALUES (?,?,?,?)", teamId, org.id, name, now());
        // Whoever makes a team is on it; a Lead's teams are the ones they lead.
        store.run("INSERT OR IGNORE INTO team_members VALUES (?,?)", teamId, user.id);
        audit(org, "team.create", teamId, { name });
      });
      return { id: teamId, name, orgId: org.id };
    }
    case "teams_update": {
      const { org, team: t } = team();
      const name = text(args.name, "Team name", 80);
      store.run("UPDATE teams SET name=? WHERE id=?", name, t.id);
      audit(org, "team.rename", t.id, { from: t.name, to: name });
      return { ok: true };
    }
    case "teams_delete": {
      const { org, team: t } = team();
      store.run("DELETE FROM teams WHERE id=?", t.id);
      audit(org, "team.delete", t.id, { name: t.name });
      return { ok: true };
    }
    case "team_members_list": {
      const { team: t } = team("member");
      return store.all("SELECT u.id,u.displayName,e.email,m.role FROM team_members tm JOIN users u ON u.id=tm.userId JOIN account_emails e ON e.userId=u.id JOIN members m ON m.orgId=? AND m.userId=u.id WHERE tm.teamId=? ORDER BY e.email", t.orgId, t.id);
    }
    case "team_members_add": {
      const { org, team: t } = team();
      const target = targetUser();
      if (!store.get("SELECT userId FROM members WHERE orgId=? AND userId=?", org.id, target.id)) throw new HttpError(400, "Add this person to the organization first.");
      store.run("INSERT OR IGNORE INTO team_members VALUES (?,?)", t.id, target.id);
      audit(org, "team.member.add", t.id, { userId: target.id, email: target.email });
      return { ok: true };
    }
    case "team_members_remove": {
      const { org, team: t } = team();
      const target = targetUser();
      store.run("DELETE FROM team_members WHERE teamId=? AND userId=?", t.id, target.id);
      audit(org, "team.member.remove", t.id, { userId: target.id, email: target.email });
      return { ok: true };
    }

    // ---------------------------------------------------------- workspaces
    case "workspaces_list": {
      const { org, role } = store.member(user, orgId());
      const all = role === "owner" || role === "admin";
      const rows = store.all<{ id: string; orgId: string; teamId: string | null; name: string; description: string; createdBy: string; createdAt: string; updatedAt: string; team: string | null }>(
        `SELECT w.*,t.name AS team FROM workspaces w LEFT JOIN teams t ON t.id=w.teamId WHERE w.orgId=? AND (w.teamId IS NULL${all ? " OR 1=1" : " OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.teamId=w.teamId AND tm.userId=?)"}) ORDER BY w.name`,
        org.id, ...(all ? [] : [user.id]));
      return rows.map((w) => ({ ...w, repos: repos(w.id) }));
    }
    case "workspaces_get": {
      const { workspace: w } = workspace(false);
      return { ...w, repos: repos(w.id) };
    }
    case "workspaces_create": {
      const { org, role } = store.require(user, orgId(), "manageWorkspaces");
      store.requireFeature(org, "workspaces.shared");
      const name = text(args.name, "Workspace name", 80);
      const description = args.description === undefined ? "" : text(args.description, "Description", 500);
      const teamId = args.teamId ? key(args, "teamId") : null;
      if (teamId) {
        store.requireFeature(org, "teams");
        if (!store.get("SELECT id FROM teams WHERE id=? AND orgId=?", teamId, org.id)) throw new HttpError(400, "Team must belong to this organization.");
        if (role === "lead" && !store.get("SELECT userId FROM team_members WHERE teamId=? AND userId=?", teamId, user.id)) throw new HttpError(403, "A Lead makes workspaces for teams they are on.");
      } else if (role === "lead") throw new HttpError(403, "A Lead makes team workspaces; organization-wide workspaces need an Owner or Admin.");
      if (store.get<{ n: number }>("SELECT COUNT(*) AS n FROM workspaces WHERE orgId=?", org.id)!.n >= 200) throw new HttpError(413, "Workspace limit reached (200 per organization).");
      const workspaceId = id();
      store.run("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?)", workspaceId, org.id, teamId, name, description, user.id, now(), now());
      audit(org, "workspace.create", workspaceId, { name, teamId });
      return { id: workspaceId, orgId: org.id, teamId, name, description, repos: [] };
    }
    case "workspaces_update": {
      const { org, workspace: w } = workspace(true);
      const name = args.name === undefined ? w.name : text(args.name, "Workspace name", 80);
      const description = args.description === undefined ? w.description : text(args.description, "Description", 500);
      store.run("UPDATE workspaces SET name=?,description=?,updatedAt=? WHERE id=?", name, description, now(), w.id);
      audit(org, "workspace.update", w.id, { name });
      return { ok: true };
    }
    case "workspaces_delete": {
      const { org, workspace: w } = workspace(true);
      store.run("DELETE FROM workspaces WHERE id=?", w.id);
      audit(org, "workspace.delete", w.id, { name: w.name });
      return { ok: true };
    }
    case "workspace_repos_add": {
      const { org, workspace: w } = workspace(true);
      const url = repoUrl(args.url);
      const name = args.name === undefined ? repoNameOf(url) : text(args.name, "Repository name", 120);
      if (repos(w.id).length >= 500) throw new HttpError(413, "A workspace holds up to 500 repositories.");
      store.run("INSERT INTO workspace_repos VALUES (?,?,?,?,?) ON CONFLICT(workspaceId,url) DO UPDATE SET name=excluded.name", w.id, url, name, user.id, now());
      store.run("UPDATE workspaces SET updatedAt=? WHERE id=?", now(), w.id);
      audit(org, "workspace.repo.add", w.id, { url, name });
      return { ok: true, url, name };
    }
    case "workspace_repos_remove": {
      const { org, workspace: w } = workspace(true);
      const url = repoUrl(args.url);
      if (!store.run("DELETE FROM workspace_repos WHERE workspaceId=? AND url=?", w.id, url).changes) throw new HttpError(404, "That repository is not in the workspace.");
      audit(org, "workspace.repo.remove", w.id, { url });
      return { ok: true };
    }

    // ---------------------------------------------------------- plan and seats
    case "plan_get": {
      const { org, role } = store.member(user, orgId());
      return {
        plan: org.plan,
        planName: PLAN_SPECS[org.plan].name,
        role,
        seats: store.seats(org),
        entitlements: entitlements(org.plan),
        plans: PLANS.map((p) => ({ plan: p, name: PLAN_SPECS[p].name, seatCap: PLAN_SPECS[p].seatCap, price: PLAN_SPECS[p].price, current: p === org.plan })),
        entitlement: store.get("SELECT product,principal,status,seats,source,updatedAt FROM entitlements WHERE orgId=?", org.id),
        upgrade: `${origin}/pricing?org=${org.id}`,
      };
    }
    case "plan_request": {
      const { org } = store.require(user, orgId(), "billing");
      const wanted = parsePlan(args.plan);
      if (!atLeast(wanted, org.plan) || wanted === org.plan) throw new HttpError(400, `${org.name} is already on ${capital(org.plan)}. Downgrades happen when an entitlement lapses.`);
      audit(org, "plan.request", wanted, { from: org.plan });
      return { plan: wanted, pay: `${origin}/pricing?org=${org.id}&plan=${wanted}`, product: `${new URL(origin).host}/${wanted}`, principal: org.principal };
    }
    case "plan_set": {
      if (!user.admin) throw new HttpError(403, "Plans are set by an entitlement, or by the site administrator.");
      const org = store.org(orgId());
      const next = parsePlan(args.plan);
      // Without a count, a plan comes with every seat it allows; Enterprise
      // keeps what the organization had.
      const seats = args.seats === undefined ? PLAN_SPECS[next].seatCap ?? Math.max(org.seats, 1) : seatCount(args.seats, next);
      store.transaction(() => {
        store.run("UPDATE organizations SET plan=?,seats=? WHERE id=?", next, seats, org.id);
        store.run("INSERT INTO entitlements VALUES (?,?,?,?,?,?,?) ON CONFLICT(orgId) DO UPDATE SET product=excluded.product,principal=excluded.principal,status=excluded.status,seats=excluded.seats,source=excluded.source,updatedAt=excluded.updatedAt",
          org.id, `${new URL(origin).host}/${next}`, org.principal ?? "", "active", seats, "admin", now());
        audit(org, "plan.set", next, { from: org.plan, seats, by: "admin" });
      });
      return { ok: true, plan: next, seats };
    }
    case "seats_set": {
      const { org } = store.require(user, orgId(), "billing");
      const seats = seatCount(args.seats, org.plan);
      const usage = store.seats(org);
      if (seats < usage.used + usage.pending) throw new HttpError(409, `${usage.used + usage.pending} seats are in use or invited; remove people before going below that.`);
      store.run("UPDATE organizations SET seats=? WHERE id=?", seats, org.id);
      audit(org, "seats.set", "", { from: org.seats, to: seats });
      return { ok: true, seats: seatUsage(org.plan, seats, store.members(org.id), store.invitations(org.id)) };
    }

    // ---------------------------------------------------------- audit
    case "audit_list": {
      const { org } = store.require(user, orgId(), "audit");
      const [limit, offset] = page(args);
      return store.all<{ id: string; actorId: string | null; action: string; target: string; details: string; at: string; actor: string | null }>(
        "SELECT a.id,a.actorId,a.action,a.target,a.details,a.at,e.email AS actor FROM audit a LEFT JOIN account_emails e ON e.userId=a.actorId WHERE a.orgId=? ORDER BY a.seq DESC LIMIT ? OFFSET ?", org.id, limit, offset,
      ).map((row) => ({ ...row, details: JSON.parse(row.details) as Record<string, unknown> }));
    }
    case "audit_export": {
      const { org } = store.require(user, orgId(), "audit");
      store.requireFeature(org, "audit.export");
      const rows: (string | null)[][] = [["at", "actor", "action", "target", "details"]];
      for (const row of store.all<{ actor: string | null; action: string; target: string; details: string; at: string }>(
        "SELECT a.action,a.target,a.details,a.at,e.email AS actor FROM audit a LEFT JOIN account_emails e ON e.userId=a.actorId WHERE a.orgId=? ORDER BY a.seq", org.id)) {
        rows.push([row.at, row.actor, row.action, row.target, row.details]);
      }
      return { csv: csv(rows), filename: `${org.name.replace(/[^\w.-]+/g, "_")}-audit.csv` };
    }

    // ---------------------------------------------------------- tokens
    case "tokens_list":
      return store.all("SELECT id,kind,label,expiresAt,createdAt FROM sessions WHERE userId=? AND kind!='browser' AND expiresAt>? ORDER BY createdAt DESC", user.id, now());
    case "tokens_create":
      return store.session(user, "api", args.label === undefined ? "API token" : text(args.label, "Token label", 80));
    case "tokens_revoke":
      store.run("DELETE FROM sessions WHERE id=? AND userId=? AND kind!='browser'", key(args, "tokenId"), user.id);
      return { ok: true };

    // ---------------------------------------------------------- site admin
    case "admin_claim": {
      const configured = process.env.G1TZ_ADMIN_BOOTSTRAP_SECRET;
      if (!configured || checksum(key(args, "token")) !== checksum(configured)) throw new HttpError(403, "Invalid administrator setup link.");
      store.transaction(() => {
        if (store.get("SELECT key FROM settings WHERE key='admin_claimed'")) throw new HttpError(409, "Administrator access has already been claimed.");
        store.run("UPDATE users SET admin=1 WHERE id=?", user.id);
        store.run("INSERT INTO settings VALUES ('admin_claimed',?)", user.id);
      });
      return store.user(user.id);
    }
    case "admin_organizations":
      if (!user.admin) throw new HttpError(403, "Site administrator access required.");
      return store.all("SELECT o.id,o.name,o.plan,o.seats,o.principal,o.createdAt,e.email AS owner,(SELECT COUNT(*) FROM members m WHERE m.orgId=o.id) AS members FROM organizations o JOIN account_emails e ON e.userId=o.ownerId ORDER BY o.createdAt DESC LIMIT 1000");

    default:
      throw new HttpError(404, `Unknown operation: ${operation}.`);
  }
}

function seatCount(value: unknown, forPlan: Plan): number {
  const seats = Number(value);
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > 100000) throw new HttpError(400, "Seats must be a whole number.");
  const cap = PLAN_SPECS[forPlan].seatCap;
  if (cap !== null && seats > cap) throw new HttpError(409, `The ${forPlan} plan allows ${cap} seats. Upgrade for more.`, { cap });
  return seats;
}

/** A remote as git would print it: https, ssh or scp-style, no whitespace. */
export function repoUrl(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url || url.length > 500 || /\s/.test(url)) throw new HttpError(400, "Give the repository's remote URL.");
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/.test(url)) throw new HttpError(400, "A remote URL starts with https://, ssh://, git:// or user@host:.");
  return url;
}
export function repoNameOf(url: string): string {
  const tail = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? url;
  return tail.replace(/\.git$/, "") || url;
}

export const OPERATIONS = [
  "account_me", "organizations_list", "organizations_create", "organizations_get", "organizations_update", "organizations_delete", "organizations_transfer", "organizations_link", "domains_set",
  "members_list", "members_invite", "members_update", "members_remove", "members_leave", "members_export", "members_import",
  "invitations_list", "invitations_revoke", "invitations_accept",
  "teams_list", "teams_create", "teams_update", "teams_delete", "team_members_list", "team_members_add", "team_members_remove",
  "workspaces_list", "workspaces_get", "workspaces_create", "workspaces_update", "workspaces_delete", "workspace_repos_add", "workspace_repos_remove",
  "plan_get", "plan_request", "plan_set", "seats_set", "audit_list", "audit_export", "tokens_list", "tokens_create", "tokens_revoke", "admin_claim", "admin_organizations",
] as const;
export const ROLE_NAMES = ROLES;
export { hasFeature };
