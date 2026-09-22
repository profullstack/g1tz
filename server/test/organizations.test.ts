import { test, expect, beforeAll, afterAll } from "bun:test";
import { fails, firstOrg, harness, makeAdmin, type Client, type Harness } from "./fixtures.ts";
import { parseCsv } from "../operations.ts";

let h: Harness;
let admin: Client;
beforeAll(async () => {
  h = await harness();
  admin = await h.signIn("root@g1tz.test");
  await makeAdmin(admin);
});
afterAll(() => h.stop());

const setPlan = (orgId: string, plan: string, seats?: number) => admin.call("plan_set", { orgId, plan, seats });

/** Accept the newest invitation for `email` by signing that mailbox in. */
async function accept(email: string): Promise<Client> {
  const invite = h.mails.invites.filter((m) => m.to === email).at(-1);
  if (!invite) throw new Error(`no invitation for ${email}`);
  const client = await h.signIn(email);
  await client.call("invitations_accept", { token: invite.url.split("#invite=")[1] });
  return client;
}

test("Community cannot invite: the refusal names the plan that can", async () => {
  const owner = await h.signIn("solo@acme.test");
  const org = await firstOrg(owner);
  const refused = await fails(owner.call("members_invite", { orgId: org.id, email: "pal@acme.test" }));
  expect(refused.status).toBe(402);
  expect(refused.body).toMatchObject({ feature: "members.invite", plan: "pro", current: "community" });
  expect(refused.message).toMatch(/needs the Pro plan/);
});

test("Pro: seats are counted, invitations hold one, the Billing Contact holds none", async () => {
  const owner = await h.signIn("owner@pro.test");
  const org = await firstOrg(owner);
  await setPlan(org.id, "pro");
  const plan = await owner.call<{ seats: { used: number; pending: number; seats: number; cap: number; free: number } }>("plan_get", { orgId: org.id });
  expect(plan.seats).toEqual({ used: 1, pending: 0, seats: 2, cap: 2, free: 1 });

  const invited = await owner.call<{ email: string; role: string; url: string }>("members_invite", { orgId: org.id, email: "Two@Pro.test", role: "user" });
  expect(invited.email).toBe("two@pro.test");
  expect(h.mails.invites.at(-1)).toMatchObject({ to: "two@pro.test", org: org.name, inviter: "owner", role: "user" });

  const full = await fails(owner.call("members_invite", { orgId: org.id, email: "three@pro.test" }));
  expect(full.status).toBe(409);
  expect(full.message).toMatch(/every seat the pro plan allows/);

  // A Billing Contact fits when no seat is free.
  const billing = await owner.call<{ role: string }>("members_invite", { orgId: org.id, email: "money@pro.test", role: "billing" });
  expect(billing.role).toBe("billing");
  const after = await owner.call<{ seats: { used: number; pending: number; free: number } }>("members_list", { orgId: org.id });
  expect(after.seats).toMatchObject({ used: 1, pending: 1, free: 0 });

  const two = await accept("two@pro.test");
  const members = await owner.call<{ members: { email: string; role: string }[]; invitations: unknown[] }>("members_list", { orgId: org.id });
  expect(members.members.map((m) => `${m.email}:${m.role}`)).toEqual(["owner@pro.test:owner", "two@pro.test:user"]);
  expect(members.invitations).toHaveLength(1);

  // A User has no administration.
  const denied = await fails(two.call("members_invite", { orgId: org.id, email: "four@pro.test" }));
  expect(denied.status).toBe(403);
  expect(denied.message).toMatch(/Owner or Admin role; you are a user/);
  const noAudit = await fails(two.call("audit_list", { orgId: org.id }));
  expect(noAudit.status).toBe(403);

  // The Owner is not editable; ownership transfers.
  const ownerEdit = await fails(owner.call("members_update", { orgId: org.id, email: "owner@pro.test", role: "user" }));
  expect(ownerEdit.status).toBe(409);
  await owner.call("members_update", { orgId: org.id, email: "two@pro.test", role: "admin" });
  const adminRemovesOwner = await fails(two.call("members_remove", { orgId: org.id, email: "owner@pro.test" }));
  expect(adminRemovesOwner.status).toBe(409);
  const adminTransfers = await fails(two.call("organizations_transfer", { orgId: org.id, email: "two@pro.test" }));
  expect(adminTransfers.status).toBe(403);
  await owner.call("organizations_transfer", { orgId: org.id, email: "two@pro.test" });
  const moved = await two.call<{ members: { email: string; role: string }[] }>("members_list", { orgId: org.id });
  expect(moved.members.map((m) => `${m.email}:${m.role}`)).toEqual(["two@pro.test:owner", "owner@pro.test:admin"]);

  // Nobody accepts someone else's invitation.
  const money = h.mails.invites.find((m) => m.to === "money@pro.test")!;
  const wrongPerson = await fails(two.call("invitations_accept", { token: money.url.split("#invite=")[1] }));
  expect(wrongPerson.status).toBe(403);
  expect(wrongPerson.message).toMatch(/sent to money@pro.test/);

  const audit = await two.call<{ action: string; actor: string | null }[]>("audit_list", { orgId: org.id });
  expect(audit.map((a) => a.action).slice(0, 4)).toEqual(["organization.transfer", "member.role", "member.join", "member.invite"]);
  expect(audit.every((a) => a.actor === null || a.actor.endsWith("@pro.test") || a.actor === "root@g1tz.test")).toBe(true);
});

test("the Lead role and teams follow the plan; a team's workspace is only its team's", async () => {
  const owner = await h.signIn("owner@adv.test");
  const org = await firstOrg(owner);
  await setPlan(org.id, "pro");
  const noTeams = await fails(owner.call("teams_create", { orgId: org.id, name: "Core" }));
  expect(noTeams.status).toBe(402);
  expect(noTeams.body.plan).toBe("advanced");

  await setPlan(org.id, "advanced");
  const core = await owner.call<{ id: string }>("teams_create", { orgId: org.id, name: "Core" });
  const dup = await fails(owner.call("teams_create", { orgId: org.id, name: "Core" }));
  expect(dup.status).toBe(409);

  // Lead needs Insights, which is Business.
  const noLead = await fails(owner.call("members_invite", { orgId: org.id, email: "lead@adv.test", role: "lead" }));
  expect(noLead.status).toBe(402);
  expect(noLead.body.feature).toBe("insights");
  await setPlan(org.id, "business");
  await owner.call("members_invite", { orgId: org.id, email: "lead@adv.test", role: "lead", teamId: core.id });
  await owner.call("members_invite", { orgId: org.id, email: "user@adv.test", role: "user" });
  const lead = await accept("lead@adv.test");
  const user = await accept("user@adv.test");

  const teams = await lead.call<{ name: string; members: number; member: boolean }[]>("teams_list", { orgId: org.id });
  expect(teams).toEqual([expect.objectContaining({ name: "Core", members: 2, member: true })]);
  // A Lead manages teams but not users.
  await lead.call("team_members_add", { teamId: core.id, email: "user@adv.test" });
  const leadInvites = await fails(lead.call("members_invite", { orgId: org.id, email: "x@adv.test" }));
  expect(leadInvites.status).toBe(403);
  const outsider = await fails(lead.call("team_members_add", { teamId: core.id, email: "root@g1tz.test" }));
  expect(outsider.status).toBe(400);

  // Workspaces: org-wide for everyone, team ones for the team.
  const shared = await owner.call<{ id: string }>("workspaces_create", { orgId: org.id, name: "Everything" });
  const teamOnly = await lead.call<{ id: string }>("workspaces_create", { orgId: org.id, name: "Core repos", teamId: core.id });
  const leadOrgWide = await fails(lead.call("workspaces_create", { orgId: org.id, name: "Nope" }));
  expect(leadOrgWide.status).toBe(403);
  await lead.call("workspace_repos_add", { workspaceId: teamOnly.id, url: "git@github.com:acme/core.git" });
  await owner.call("workspace_repos_add", { workspaceId: shared.id, url: "https://github.com/acme/site", name: "Site" });
  const badUrl = await fails(owner.call("workspace_repos_add", { workspaceId: shared.id, url: "not a url" }));
  expect(badUrl.status).toBe(400);

  await lead.call("team_members_remove", { teamId: core.id, email: "user@adv.test" });
  const userSees = await user.call<{ name: string; repos: { name: string }[] }[]>("workspaces_list", { orgId: org.id });
  expect(userSees.map((w) => w.name)).toEqual(["Everything"]);
  expect(userSees[0]!.repos).toEqual([expect.objectContaining({ name: "Site" })]);
  const hidden = await fails(user.call("workspaces_get", { workspaceId: teamOnly.id }));
  expect(hidden.status).toBe(404);
  const leadSees = await lead.call<{ name: string; team: string | null; repos: { name: string }[] }[]>("workspaces_list", { orgId: org.id });
  expect(leadSees.map((w) => `${w.name}/${w.team ?? "org"}`)).toEqual(["Core repos/Core", "Everything/org"]);
  expect(leadSees[0]!.repos[0]!.name).toBe("core");

  // Deleting the team takes its workspace with it.
  await owner.call("teams_delete", { teamId: core.id });
  const gone = await fails(owner.call("workspaces_get", { workspaceId: teamOnly.id }));
  expect(gone.status).toBe(404);
});

test("verified domains: one on Advanced, many on Business, never a public mailbox, and sign-in joins", async () => {
  const owner = await h.signIn("boss@corp.test");
  const org = await firstOrg(owner);
  await setPlan(org.id, "advanced", 10);
  const gmail = await fails(owner.call("domains_set", { orgId: org.id, domains: ["gmail.com"] }));
  expect(gmail.status).toBe(400);
  const unproven = await fails(owner.call("domains_set", { orgId: org.id, domains: ["other.test"] }));
  expect(unproven.message).toMatch(/Verify other.test/);
  const two = await fails(owner.call("domains_set", { orgId: org.id, domains: ["corp.test", "corp2.test"] }));
  expect(two.status).toBe(402);
  expect(two.body.feature).toBe("sso.domains");
  await owner.call("domains_set", { orgId: org.id, domains: ["corp.test"] });

  const newcomer = await h.signIn("new@corp.test");
  const me = await newcomer.call<{ organizations: { id: string; role: string }[] }>("account_me");
  expect(me.organizations).toContainEqual(expect.objectContaining({ id: org.id, role: "user" }));
  const stranger = await h.signIn("new@elsewhere.test");
  const theirs = await stranger.call<{ organizations: { id: string }[] }>("account_me");
  expect(theirs.organizations.map((o) => o.id)).not.toContain(org.id);
});

test("members export and import round-trip through CSV", async () => {
  const owner = await h.signIn("csv@corp2.test");
  const org = await firstOrg(owner);
  await setPlan(org.id, "business", 100);
  const imported = await owner.call<{ invited: number; failed: number; results: { email: string; ok: boolean; message: string }[] }>("members_import", {
    orgId: org.id,
    csv: 'email,role,team\n"a@corp2.test",user,Platform\nb@corp2.test,admin,\nbad-address,user,\n"=cmd()@corp2.test",user,\n',
  });
  expect(imported.invited).toBe(2);
  expect(imported.failed).toBe(2);
  const exported = await owner.call<{ csv: string }>("members_export", { orgId: org.id });
  const rows = parseCsv(exported.csv);
  expect(rows[0]).toEqual(["email", "name", "role", "seat", "teams", "since"]);
  expect(rows.slice(1).map((r) => `${r[0]}:${r[2]}:${r[3]}`)).toEqual(["csv@corp2.test:owner:yes", "a@corp2.test:user:invited", "b@corp2.test:admin:invited"]);
  const teams = await owner.call<{ name: string }[]>("teams_list", { orgId: org.id });
  expect(teams.map((t) => t.name)).toEqual(["Platform"]);
  const download = await owner.fetch(`/api/v1/organizations/${org.id}/members.csv`);
  expect(download.headers.get("content-type")).toMatch(/text\/csv/);
  expect(await download.text()).toBe(exported.csv);
});

test("audit export is a Business feature; the plan card lists every lock", async () => {
  const owner = await h.signIn("audit@corp3.test");
  const org = await firstOrg(owner);
  await setPlan(org.id, "pro");
  const locked = await fails(owner.call("audit_export", { orgId: org.id }));
  expect(locked.status).toBe(402);
  const plan = await owner.call<{ plan: string; entitlements: { feature: string; unlocked: boolean; plan: string }[]; plans: { plan: string; current: boolean }[] }>("plan_get", { orgId: org.id });
  expect(plan.plan).toBe("pro");
  expect(plan.entitlements.find((e) => e.feature === "members.invite")?.unlocked).toBe(true);
  expect(plan.entitlements.find((e) => e.feature === "teams")).toMatchObject({ unlocked: false, plan: "advanced" });
  expect(plan.plans.find((p) => p.current)?.plan).toBe("pro");
  const request = await owner.call<{ pay: string; product: string }>("plan_request", { orgId: org.id, plan: "business" });
  expect(request.pay).toContain(`/pricing?org=${org.id}&plan=business`);
  expect(request.product).toMatch(/\/business$/);
  const notAdmin = await fails(owner.call("plan_set", { orgId: org.id, plan: "enterprise" }));
  expect(notAdmin.status).toBe(403);
});

test("deleting an organization needs its name; leaving needs a new owner first", async () => {
  const owner = await h.signIn("del@corp4.test");
  const org = await firstOrg(owner);
  const leave = await fails(owner.call("members_leave", { orgId: org.id }));
  expect(leave.status).toBe(409);
  const unconfirmed = await fails(owner.call("organizations_delete", { orgId: org.id }));
  expect(unconfirmed.status).toBe(428);
  await owner.call("organizations_delete", { orgId: org.id, confirm: org.name });
  const orgs = await owner.call<{ id: string }[]>("organizations_list");
  expect(orgs.map((o) => o.id)).not.toContain(org.id);
});
