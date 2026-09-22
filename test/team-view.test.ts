import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToText } from "@profullstack/hqtui/testing";
import { createTeamState, cyclePane, loadTeam, moveTeam, teamView, type TeamData } from "../src/team-view.ts";
import { entitlements } from "../src/teams-model.ts";
import type { FetchLike } from "../src/cloud-client.ts";

const frame = (state: ReturnType<typeof createTeamState>, width = 120, height = 32): string =>
  renderToText((args) => teamView(args as never, state), { width, height });

function data(): TeamData {
  return {
    me: { email: "ann@acme.test", displayName: "Ann" },
    org: { id: "o1", name: "Acme", plan: "pro", role: "owner", seats: { used: 2, pending: 1, seats: 2, cap: 2, free: 0 }, domains: [] },
    members: [
      { email: "ann@acme.test", displayName: "Ann", role: "owner", teams: [] },
      { email: "bo@acme.test", displayName: "Bo", role: "user", teams: [] },
      { email: "cash@acme.test", displayName: "Cash", role: "billing", teams: [] },
    ],
    invitations: [{ email: "dee@acme.test", role: "user" }],
    teams: [],
    workspaces: [{ id: "w1", name: "Everything", team: null, description: "", repos: [{ url: "https://github.com/acme/site", name: "site" }] }],
    entitlements: entitlements("pro"),
  };
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("signed out, the screen says how to sign in", () => {
  const s = createTeamState("https://g1tz.hqtui.com");
  const out = frame(s);
  assert.match(out, /Sign in/);
  assert.match(out, /g1tz login/);
  assert.match(out, /Owner, Admin, Lead, User and Billing Contact/);
  assert.match(out, /r Refresh/);
});

test("signed in, the panes show members with roles, invitations, workspaces, seats and locks", () => {
  const s = createTeamState("https://g1tz.hqtui.com");
  s.status = "ready";
  s.data = data();
  const out = frame(s);
  assert.match(out, /Acme/);
  assert.match(out, /Pro\s+2\/2 seats\s+you: owner/);
  assert.match(out, /Members \(3, 1 invited\)/);
  assert.match(out, /ann@acme.test\s+owner/);
  assert.match(out, /cash@acme.test\s+billing/);
  assert.match(out, /dee@acme.test\s+user\s+invited/);
  assert.match(out, /Teams need the Advanced plan/);
  assert.match(out, /Workspaces \(1\)/);
  assert.match(out, /▸ Everything\s+1 repo/);
  assert.match(out, /site\s+https:\/\/github.com\/acme\/site/);
  assert.match(out, /2 in use, 1 invited, 0 free of 2 \(cap 2\)/);
  assert.match(out, /✓\s+Pro\s+Invite people and assign roles/);
  assert.match(out, /🔒 Advanced\s+Teams, and workspaces only a team sees/);
  assert.match(out, /🔒 Business\s+Insights and the Lead role/);
  assert.match(out, /changes: g1tz members/);
});

test("panes cycle and the selection stays inside each list", () => {
  const s = createTeamState();
  s.status = "ready";
  s.data = data();
  assert.equal(s.pane, "members");
  moveTeam(s, 10);
  assert.equal(s.selected.members, 2);
  cyclePane(s);
  assert.equal(s.pane, "teams");
  moveTeam(s, 1);
  assert.equal(s.selected.teams, 0, "an empty list has nothing to select");
  cyclePane(s);
  cyclePane(s);
  assert.equal(s.pane, "members");
  moveTeam(s, -10);
  assert.equal(s.selected.members, 0);
});

test("loading reads the account, the remembered organization, and every pane at once", async () => {
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    const { operation, args } = JSON.parse(String(init?.body)) as { operation: string; args: { orgId?: string } };
    seen.push(`${operation}:${args.orgId ?? ""}`);
    const d = data();
    switch (operation) {
      case "account_me": return reply({ email: "ann@acme.test", displayName: "Ann", organizations: [{ id: "o0", name: "Other" }, { id: "o1", name: "Acme" }] });
      case "organizations_get": return reply(d.org);
      case "members_list": return reply({ members: d.members, invitations: d.invitations, seats: d.org.seats });
      case "teams_list": return reply(d.teams);
      case "workspaces_list": return reply(d.workspaces);
      case "plan_get": return reply({ entitlements: d.entitlements });
      default: return reply({ error: "no" }, 404);
    }
  };
  const s = createTeamState();
  let changes = 0;
  await loadTeam(s, { url: "https://s", token: "t".repeat(43), org: "o1" }, () => { changes++; }, fetchImpl);
  assert.equal(s.status, "ready");
  assert.equal(s.data?.org.name, "Acme");
  assert.deepEqual(seen, ["account_me:", "organizations_get:o1", "members_list:o1", "teams_list:o1", "workspaces_list:o1", "plan_get:o1"]);
  assert.equal(changes, 2);
});

test("no token means signed out; a revoked token means signed out with the server's words; an older reply is dropped", async () => {
  const s = createTeamState();
  await loadTeam(s, { url: "https://s" }, () => {}, async () => { throw new Error("must not be called"); });
  assert.equal(s.status, "signed-out");

  const revoked: FetchLike = async () => reply({ error: "Sign in, or run g1tz login." }, 401);
  await loadTeam(s, { url: "https://s", token: "t".repeat(43) }, () => {}, revoked);
  assert.equal(s.status, "signed-out");
  assert.match(s.note, /g1tz login/);

  const broken: FetchLike = async () => reply({ error: "The server could not complete this request." }, 500);
  await loadTeam(s, { url: "https://s", token: "t".repeat(43) }, () => {}, broken);
  assert.equal(s.status, "error");
  assert.match(frame(s), /could not complete/);

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: FetchLike = async () => { await gate; return reply({ email: "x", displayName: "x", organizations: [] }); };
  const first = loadTeam(s, { url: "https://s", token: "t".repeat(43) }, () => {}, slow);
  const second = loadTeam(s, { url: "https://s", token: "t".repeat(43) }, () => {}, broken);
  await second;
  assert.equal(s.status, "error");
  release();
  await first;
  assert.equal(s.status, "error", "the slow first reply did not overwrite the newer one");
});
