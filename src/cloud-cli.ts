/**
 * The team half of the command line: sign in, organizations, members, teams,
 * workspaces, plan, audit. Every command is one operation on the server; the
 * server decides what the role and the plan allow, and this prints the answer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { clearConfig, cloudConfig, DEFAULT_URL, writeConfig, type CloudConfig } from "./account.ts";
import { cloudAction, cloudRequest, deviceLogin, CloudError, type FetchLike } from "./cloud-client.ts";
import { PLAN_LINES, PLAN_SPECS, PLANS, ROLE_LINES, ROLES, type Plan, type Role } from "./teams-model.ts";

export const CLOUD_USAGE = `Teams (an account at ${DEFAULT_URL}, or G1TZ_URL)
  g1tz login [--label NAME]            Sign in from this terminal: a code, approved in the browser
  g1tz logout | whoami
  g1tz org list | create NAME | show [ID] | use ID | rename ID NAME
  g1tz org transfer ID EMAIL | link ID PRINCIPAL | domains ID [DOMAIN ...] | delete ID
  g1tz members [--org ID]              Members, roles, teams, seats
  g1tz members invite EMAIL [--role ${ROLES.join("|")}] [--team ID]
  g1tz members role EMAIL ROLE | remove EMAIL | leave
  g1tz members export [--out FILE] | import FILE
  g1tz invites | invites accept ID | invites revoke ID
  g1tz teams | teams create NAME | rename ID NAME | delete ID
  g1tz teams members ID | add ID EMAIL | remove ID EMAIL
  g1tz workspaces | workspaces create NAME [--team ID] [--description TEXT]
  g1tz workspaces show ID | delete ID | add ID URL [--name NAME] | rm ID URL
  g1tz plan | plan request ${PLANS.slice(1).join("|")} | plan seats N
  g1tz audit [--limit N] [--export FILE]
  g1tz cloud OPERATION [--args JSON]    Any operation, raw

--org ID or G1TZ_ORG picks the organization; \`g1tz org use ID\` remembers one.
--json prints the server's answer instead of a table.`;

const COMMANDS = new Set(["login", "logout", "whoami", "org", "orgs", "members", "invites", "teams", "workspaces", "workspace", "plan", "audit", "cloud"]);
export const isCloudCommand = (command: string | undefined): boolean => !!command && COMMANDS.has(command);

export interface CloudIo {
  out: (line: string) => void;
  err: (line: string) => void;
  fetchImpl?: FetchLike;
  config?: CloudConfig;
  configRoot?: string;
  sleep?: (ms: number) => Promise<void>;
}

const BOOLEAN_FLAGS = new Set(["json", "help", "h"]);

export function parseArgs(argv: readonly string[]): { positional: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") { flags.help = "true"; continue; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) { flags[name] = a.slice(eq + 1); continue; }
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = "true"; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} needs a value.`);
    flags[name] = next;
    i++;
  }
  return { positional, flags };
}

/** Left-aligned columns, no borders: it pipes. */
export function table(rows: Record<string, unknown>[], columns: { key: string; title: string }[]): string {
  if (rows.length === 0) return "";
  const cell = (row: Record<string, unknown>, key: string): string => {
    const v = row[key];
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" && "name" in x ? String((x as { name: unknown }).name) : String(x))).join(", ");
    return String(v);
  };
  const widths = columns.map((c) => Math.max(c.title.length, ...rows.map((r) => cell(r, c.key).length)));
  const line = (values: string[]) => values.map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(columns.map((c) => c.title)), ...rows.map((r) => line(columns.map((c) => cell(r, c.key))))].join("\n");
}

const when = (iso: unknown): string => (typeof iso === "string" ? iso.slice(0, 10) : "");
const capital = (value: string) => `${value[0]!.toUpperCase()}${value.slice(1)}`;

export async function cloudMain(argv: readonly string[], io: CloudIo): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, verb, ...rest] = positional;
  if (flags.help) { io.out(CLOUD_USAGE); return 0; }
  const config = io.config ?? cloudConfig(process.env, io.configRoot);
  const fetchImpl = io.fetchImpl ?? fetch;
  const call = <T = Record<string, unknown>>(operation: string, args: Record<string, unknown> = {}) => cloudAction<T>(operation, args, config, fetchImpl);
  const print = (value: unknown) => io.out(JSON.stringify(value, null, 2));
  const json = flags.json === "true";

  /** The organization to act on, resolved once. */
  const org = async (): Promise<string> => {
    if (flags.org) return flags.org;
    if (config.org) return config.org;
    const me = await call<{ organizations: { id: string; name: string; role: string }[] }>("account_me");
    const first = me.organizations[0];
    if (!first) throw new Error("You are in no organization. Create one: g1tz org create NAME");
    if (me.organizations.length > 1) io.err(`Using ${first.name} (${first.id}); pick another with --org ID or g1tz org use ID.`);
    return first.id;
  };

  try {
    switch (command) {
      case "login": {
        const result = await deviceLogin({
          config, label: flags.label ?? `g1tz on ${process.env.HOSTNAME || process.env.HOST || "this machine"}`, fetchImpl, sleep: io.sleep,
          prompt: (start) => {
            io.out(`Open ${start.verification_uri_complete}`);
            io.out(`and confirm the code  ${start.user_code}  (it expires in ${Math.round(start.expires_in / 60)} minutes).`);
            io.out("Waiting for the browser…");
          },
        });
        writeConfig({ url: config.url, token: result.token, user: result.user, expiresAt: result.expiresAt, org: config.org }, io.configRoot);
        io.out(`Signed in as ${result.user.email} on ${config.url}.`);
        return 0;
      }
      case "logout": {
        if (config.token && !process.env.G1TZ_TOKEN) {
          try { await cloudRequest("/api/v1/logout", "POST", {}, config, fetchImpl); } catch { /* the file goes either way */ }
        }
        clearConfig(io.configRoot);
        io.out("Signed out. The token on this machine is gone; revoke others at /account.");
        return 0;
      }
      case "whoami": {
        const me = await call<{ email: string; displayName: string; organizations: { id: string; name: string; plan: string; role: string }[]; invitations: { id: string; organization: string; role: string }[] }>("account_me");
        if (json) { print(me); return 0; }
        io.out(`${me.displayName} <${me.email}> at ${config.url}`);
        io.out(table(me.organizations.map((o) => ({ ...o, plan: capital(o.plan), default: o.id === config.org ? "*" : "" })), [{ key: "default", title: "" }, { key: "id", title: "ORG" }, { key: "name", title: "NAME" }, { key: "plan", title: "PLAN" }, { key: "role", title: "ROLE" }]));
        if (me.invitations.length) io.out(`\nInvitations waiting: ${me.invitations.map((i) => `${i.organization} as ${i.role} (g1tz invites accept ${i.id})`).join("; ")}`);
        return 0;
      }
      case "org": case "orgs": {
        const [a, b] = rest;
        switch (verb ?? "list") {
          case "list": {
            const orgs = await call<Record<string, unknown>[]>("organizations_list");
            if (json) { print(orgs); return 0; }
            io.out(table(orgs.map((o) => ({ ...o, plan: capital(String(o.plan)), seats: `${(o.seats as { used: number }).used}/${(o.seats as { seats: number }).seats}`, default: o.id === config.org ? "*" : "" })),
              [{ key: "default", title: "" }, { key: "id", title: "ORG" }, { key: "name", title: "NAME" }, { key: "plan", title: "PLAN" }, { key: "seats", title: "SEATS" }, { key: "role", title: "ROLE" }]));
            return 0;
          }
          case "create": {
            const created = await call<{ id: string; name: string }>("organizations_create", { name: a });
            if (json) print(created); else io.out(`Created ${created.name} (${created.id}). Make it the default: g1tz org use ${created.id}`);
            return 0;
          }
          case "use": {
            if (!a) throw new Error("g1tz org use ID");
            await call("organizations_get", { orgId: a });
            writeConfig({ ...config, org: a }, io.configRoot);
            io.out(`Default organization: ${a}`);
            return 0;
          }
          case "show": {
            const o = await call<Record<string, unknown>>("organizations_get", { orgId: a ?? await org() });
            if (json) { print(o); return 0; }
            const seats = o.seats as { used: number; pending: number; seats: number; cap: number | null; free: number };
            const counts = o.counts as Record<string, number>;
            io.out(`${o.name}  (${o.id})\nPlan   ${capital(String(o.plan))}\nSeats  ${seats.used} in use, ${seats.pending} invited, ${seats.free} free of ${seats.seats}${seats.cap === null ? "" : ` (plan cap ${seats.cap})`}\nYou    ${o.role}\nPeople ${counts.members} members, ${counts.invitations} invitations, ${counts.teams} teams, ${counts.workspaces} workspaces${(o.domains as string[]).length ? `\nDomains ${(o.domains as string[]).join(", ")}` : ""}${o.principal ? `\nOpenAccess principal ${o.principal}` : ""}`);
            return 0;
          }
          case "rename": await call("organizations_update", { orgId: a, name: b }); io.out("Renamed."); return 0;
          case "transfer": await call("organizations_transfer", { orgId: a, email: b }); io.out(`Ownership transferred to ${b}. You are now an admin.`); return 0;
          case "link": await call("organizations_link", { orgId: a, principal: b === "none" ? null : b }); io.out(b === "none" ? "Unlinked." : `Linked to ${b}. Entitlements for that principal now set the plan.`); return 0;
          case "domains": {
            if (!a) throw new Error("g1tz org domains ID [DOMAIN ...]");
            const result = await call<{ domains: string[] }>("domains_set", { orgId: a, domains: [b, ...rest.slice(2)].filter(Boolean) });
            io.out(result.domains.length ? `Verified domains: ${result.domains.join(", ")}. New sign-ins from them join as users while seats last.` : "No verified domains.");
            return 0;
          }
          case "delete": {
            if (!a) throw new Error("g1tz org delete ID --confirm NAME");
            await call("organizations_delete", { orgId: a, confirm: flags.confirm });
            io.out("Deleted.");
            return 0;
          }
          default: throw new Error(CLOUD_USAGE);
        }
      }
      case "members": {
        const orgId = await org();
        const [a, b] = verb === undefined || verb === "list" ? [] : rest;
        switch (verb ?? "list") {
          case "list": {
            const result = await call<{ members: Record<string, unknown>[]; invitations: Record<string, unknown>[]; seats: { used: number; pending: number; seats: number; free: number } }>("members_list", { orgId });
            if (json) { print(result); return 0; }
            io.out(table(result.members.map((m) => ({ ...m, since: when(m.createdAt) })), [{ key: "email", title: "EMAIL" }, { key: "displayName", title: "NAME" }, { key: "role", title: "ROLE" }, { key: "teams", title: "TEAMS" }, { key: "since", title: "SINCE" }]));
            if (result.invitations.length) io.out(`\nInvited\n${table(result.invitations.map((i) => ({ ...i, expires: when(i.expiresAt) })), [{ key: "email", title: "EMAIL" }, { key: "role", title: "ROLE" }, { key: "expires", title: "EXPIRES" }, { key: "id", title: "ID" }])}`);
            io.out(`\nSeats: ${result.seats.used} in use, ${result.seats.pending} invited, ${result.seats.free} free of ${result.seats.seats}`);
            return 0;
          }
          case "invite": {
            const invited = await call<{ email: string; role: string; expiresAt: string; url: string }>("members_invite", { orgId, email: a, role: flags.role ?? "user", teamId: flags.team });
            if (json) print(invited); else io.out(`Invited ${invited.email} as ${invited.role}; the email carries the link (it expires ${when(invited.expiresAt)}).`);
            return 0;
          }
          case "role": await call("members_update", { orgId, email: a, role: b }); io.out(`${a} is now ${b}.`); return 0;
          case "remove": await call("members_remove", { orgId, email: a }); io.out(`Removed ${a}.`); return 0;
          case "leave": await call("members_leave", { orgId }); io.out("You left the organization."); return 0;
          case "export": {
            const result = await call<{ csv: string; filename: string }>("members_export", { orgId });
            if (flags.out) { writeFileSync(flags.out, result.csv); io.out(`Wrote ${flags.out}`); } else io.out(result.csv.trimEnd());
            return 0;
          }
          case "import": {
            if (!a) throw new Error("g1tz members import FILE   (columns: email, role, team)");
            const result = await call<{ invited: number; failed: number; results: { email: string; ok: boolean; message: string }[] }>("members_import", { orgId, csv: readFileSync(a === "-" ? 0 : a, "utf8") });
            if (json) { print(result); return 0; }
            for (const r of result.results) io.out(`${r.ok ? "✓" : "✗"} ${r.email}  ${r.message}`);
            io.out(`${result.invited} invited, ${result.failed} failed`);
            return result.failed && !result.invited ? 1 : 0;
          }
          default: throw new Error(CLOUD_USAGE);
        }
      }
      case "invites": {
        const [a] = rest;
        switch (verb ?? "list") {
          case "list": {
            const me = await call<{ invitations: Record<string, unknown>[] }>("account_me");
            if (json) { print(me.invitations); return 0; }
            io.out(me.invitations.length ? table(me.invitations.map((i) => ({ ...i, expires: when(i.expiresAt) })), [{ key: "id", title: "ID" }, { key: "organization", title: "ORGANIZATION" }, { key: "role", title: "ROLE" }, { key: "expires", title: "EXPIRES" }]) : "No invitations waiting.");
            return 0;
          }
          case "accept": {
            const joined = await call<{ organization: string; role: string; orgId: string }>("invitations_accept", { invitationId: a });
            io.out(`You joined ${joined.organization} as ${joined.role}. Make it the default: g1tz org use ${joined.orgId}`);
            return 0;
          }
          case "revoke": await call("invitations_revoke", { orgId: await org(), invitationId: a }); io.out("Revoked."); return 0;
          default: throw new Error(CLOUD_USAGE);
        }
      }
      case "teams": {
        const [a, b] = rest;
        switch (verb ?? "list") {
          case "list": {
            const teams = await call<Record<string, unknown>[]>("teams_list", { orgId: await org() });
            if (json) { print(teams); return 0; }
            io.out(teams.length ? table(teams.map((t) => ({ ...t, member: t.member ? "*" : "" })), [{ key: "member", title: "" }, { key: "id", title: "TEAM" }, { key: "name", title: "NAME" }, { key: "members", title: "MEMBERS" }]) : "No teams yet: g1tz teams create NAME");
            return 0;
          }
          case "create": {
            const t = await call<{ id: string; name: string }>("teams_create", { orgId: await org(), name: a });
            io.out(`Created ${t.name} (${t.id}).`);
            return 0;
          }
          case "rename": await call("teams_update", { teamId: a, name: b }); io.out("Renamed."); return 0;
          case "delete": await call("teams_delete", { teamId: a }); io.out("Deleted."); return 0;
          case "members": {
            const people = await call<Record<string, unknown>[]>("team_members_list", { teamId: a });
            if (json) print(people); else io.out(people.length ? table(people, [{ key: "email", title: "EMAIL" }, { key: "displayName", title: "NAME" }, { key: "role", title: "ROLE" }]) : "Nobody on this team yet.");
            return 0;
          }
          case "add": await call("team_members_add", { teamId: a, email: b }); io.out(`Added ${b}.`); return 0;
          case "remove": await call("team_members_remove", { teamId: a, email: b }); io.out(`Removed ${b}.`); return 0;
          default: throw new Error(CLOUD_USAGE);
        }
      }
      case "workspaces": case "workspace": {
        const [a, b] = rest;
        switch (verb ?? "list") {
          case "list": {
            const spaces = await call<{ id: string; name: string; team: string | null; description: string; repos: { url: string; name: string }[] }[]>("workspaces_list", { orgId: await org() });
            if (json) { print(spaces); return 0; }
            if (!spaces.length) { io.out("No workspaces yet: g1tz workspaces create NAME"); return 0; }
            for (const w of spaces) {
              io.out(`${w.name}  (${w.id})${w.team ? `  team ${w.team}` : ""}${w.description ? `\n  ${w.description}` : ""}`);
              for (const r of w.repos) io.out(`  ${r.name.padEnd(24)} ${r.url}`);
            }
            return 0;
          }
          case "create": {
            const w = await call<{ id: string; name: string }>("workspaces_create", { orgId: await org(), name: a, teamId: flags.team, description: flags.description });
            io.out(`Created ${w.name} (${w.id}). Add repositories: g1tz workspaces add ${w.id} URL`);
            return 0;
          }
          case "show": {
            const w = await call<{ id: string; name: string; description: string; repos: { url: string; name: string }[] }>("workspaces_get", { workspaceId: a });
            if (json) { print(w); return 0; }
            io.out(`${w.name}  (${w.id})${w.description ? `\n${w.description}` : ""}`);
            io.out(w.repos.length ? table(w.repos, [{ key: "name", title: "NAME" }, { key: "url", title: "URL" }]) : "No repositories yet.");
            return 0;
          }
          case "delete": await call("workspaces_delete", { workspaceId: a }); io.out("Deleted."); return 0;
          case "add": {
            const r = await call<{ name: string; url: string }>("workspace_repos_add", { workspaceId: a, url: b, name: flags.name });
            io.out(`Added ${r.name} (${r.url}).`);
            return 0;
          }
          case "rm": case "remove": await call("workspace_repos_remove", { workspaceId: a, url: b }); io.out("Removed."); return 0;
          default: throw new Error(CLOUD_USAGE);
        }
      }
      case "plan": {
        const orgId = await org();
        if (verb === "request") {
          const r = await call<{ pay: string; product: string; principal: string | null }>("plan_request", { orgId, plan: rest[0] });
          io.out(`To move to ${capital(String(rest[0]))}: ${r.pay}\nThe product is ${r.product}; the entitlement sets the plan when it lands.${r.principal ? "" : "\nLink the organization to its OpenAccess principal first: g1tz org link " + orgId + " oa_…"}`);
          return 0;
        }
        if (verb === "seats") {
          const r = await call<{ seats: { seats: number; free: number } }>("seats_set", { orgId, seats: Number(rest[0]) });
          io.out(`${r.seats.seats} seats, ${r.seats.free} free.`);
          return 0;
        }
        const p = await call<{ plan: Plan; role: Role; seats: { used: number; pending: number; free: number; seats: number; cap: number | null }; entitlements: { feature: string; line: string; plan: Plan; unlocked: boolean }[]; entitlement: { source: string; status: string; updatedAt: string } | null; upgrade: string }>("plan_get", { orgId });
        if (json) { print(p); return 0; }
        io.out(`${PLAN_SPECS[p.plan].name}: ${PLAN_LINES[p.plan].split(": ")[1]}`);
        io.out(`Seats: ${p.seats.used} in use, ${p.seats.pending} invited, ${p.seats.free} free of ${p.seats.seats}${p.seats.cap === null ? "" : ` (cap ${p.seats.cap})`}`);
        if (p.entitlement) io.out(`Entitlement: ${p.entitlement.status} via ${p.entitlement.source}, ${when(p.entitlement.updatedAt)}`);
        io.out("");
        for (const e of p.entitlements) io.out(`${e.unlocked ? "  ✓ " : "  🔒 "}${e.line}${e.unlocked ? "" : `  (${PLAN_SPECS[e.plan].name})`}`);
        io.out(`\nYour role: ${p.role}. ${ROLE_LINES[p.role]}\nUpgrade: ${p.upgrade}`);
        return 0;
      }
      case "audit": {
        const orgId = await org();
        if (flags.export) {
          const r = await call<{ csv: string }>("audit_export", { orgId });
          writeFileSync(flags.export, r.csv);
          io.out(`Wrote ${flags.export}`);
          return 0;
        }
        const rows = await call<{ at: string; actor: string | null; action: string; target: string; details: Record<string, unknown> }[]>("audit_list", { orgId, limit: flags.limit ? Number(flags.limit) : 50 });
        if (json) { print(rows); return 0; }
        io.out(rows.length ? table(rows.map((r) => ({ at: r.at.replace("T", " ").slice(0, 16), actor: r.actor ?? "system", action: r.action, details: Object.entries(r.details).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ") })),
          [{ key: "at", title: "WHEN" }, { key: "actor", title: "WHO" }, { key: "action", title: "WHAT" }, { key: "details", title: "DETAILS" }]) : "Nothing yet.");
        return 0;
      }
      case "cloud": {
        if (!verb) throw new Error(CLOUD_USAGE);
        print(await call(verb, flags.args ? JSON.parse(flags.args) as Record<string, unknown> : {}));
        return 0;
      }
      default:
        throw new Error(CLOUD_USAGE);
    }
  } catch (error) {
    if (error instanceof CloudError) {
      io.err(`g1tz: ${error.message}${error.status === 402 && error.body.plan ? `  (g1tz plan request ${String(error.body.plan)})` : ""}`);
      return error.status === 401 ? 3 : 1;
    }
    io.err(`g1tz: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
