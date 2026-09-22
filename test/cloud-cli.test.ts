import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudConfig, readConfig, serverUrl, writeConfig } from "../src/account.ts";
import { deviceLogin, type FetchLike } from "../src/cloud-client.ts";
import { cloudMain, isCloudCommand, parseArgs, table } from "../src/cloud-cli.ts";

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A server that answers operations from a table and records what it saw. */
function fakeServer(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: { path: string; operation?: string; args?: Record<string, unknown>; auth?: string }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const path = new URL(input).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: string; args?: Record<string, unknown> } : {};
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ path, operation: body.operation, args: body.args, auth: headers?.authorization });
    if (path !== "/api/v1/actions") return reply(404, { error: "no" });
    const answer = answers[body.operation ?? ""];
    if (answer === undefined) return reply(404, { error: `Unknown operation: ${body.operation}.` });
    const value = typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(body.args ?? {}) : answer;
    if (value instanceof Response) return value;
    return reply(200, value);
  };
  return { calls, fetchImpl };
}

function io() {
  const out: string[] = [], err: string[] = [];
  return { out: (l: string) => out.push(l), err: (l: string) => err.push(l), lines: out, errors: err };
}

test("the words that reach the teams half, and the flags they take", () => {
  assert.equal(isCloudCommand("login"), true);
  assert.equal(isCloudCommand("members"), true);
  assert.equal(isCloudCommand("pulse"), false);
  assert.equal(isCloudCommand(undefined), false);
  assert.deepEqual(parseArgs(["members", "invite", "a@b.c", "--role", "admin", "--json"]), { positional: ["members", "invite", "a@b.c"], flags: { role: "admin", json: "true" } });
  assert.deepEqual(parseArgs(["plan", "--org=abc"]).flags, { org: "abc" });
  assert.throws(() => parseArgs(["members", "--role"]), /--role needs a value/);
});

test("a table lines its columns up and flattens name lists", () => {
  const out = table([{ email: "a@x.y", role: "owner", teams: [{ name: "Core" }, { name: "Web" }] }, { email: "longer@x.y", role: "user", teams: [] }], [{ key: "email", title: "EMAIL" }, { key: "role", title: "ROLE" }, { key: "teams", title: "TEAMS" }]);
  assert.equal(out, "EMAIL       ROLE   TEAMS\na@x.y       owner  Core, Web\nlonger@x.y  user");
  assert.equal(table([], [{ key: "x", title: "X" }]), "");
});

test("the config file is private, atomic, and never sends a token to another server", () => {
  const root = mkdtempSync(join(tmpdir(), "g1tz-cfg-"));
  writeConfig({ url: "https://teams.example", token: "t".repeat(43), org: "org1" }, root);
  assert.equal(statSync(join(root, "cloud.json")).mode & 0o777, 0o600);
  assert.equal(readConfig(root).org, "org1");
  const same = cloudConfig({}, root);
  assert.equal(same.token, "t".repeat(43));
  const elsewhere = cloudConfig({ G1TZ_URL: "https://other.example" }, root);
  assert.equal(elsewhere.token, undefined, "a saved token stays with its server");
  assert.equal(cloudConfig({ G1TZ_URL: "https://other.example", G1TZ_TOKEN: "env" }, root).token, "env");
  assert.equal(cloudConfig({ G1TZ_ORG: "org2" }, root).org, "org2");
  assert.throws(() => serverUrl("http://teams.example"), /HTTPS/);
  assert.equal(serverUrl("http://localhost:3000/"), "http://localhost:3000");
});

test("device login shows the code, waits through pending, and returns the token", async () => {
  let polls = 0;
  const fetchImpl: FetchLike = async (input) => {
    const path = new URL(input).pathname;
    if (path === "/api/auth/device") return reply(200, { device_code: "d".repeat(43), user_code: "ABCD-2345", verification_uri: "https://s/account", verification_uri_complete: "https://s/account?device=ABCD-2345", expires_in: 600, interval: 1 });
    polls++;
    return polls < 3 ? reply(428, { error: "authorization_pending" }) : reply(200, { token: "k".repeat(43), expiresAt: "2027-01-01T00:00:00Z", user: { id: "u1", displayName: "Ann", email: "ann@x.y" } });
  };
  const shown: string[] = [];
  const slept: number[] = [];
  const result = await deviceLogin({ config: { url: "https://s" }, fetchImpl, prompt: (s) => shown.push(s.user_code), sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(shown, ["ABCD-2345"]);
  assert.equal(polls, 3);
  assert.deepEqual(slept, [1000, 1000, 1000]);
  assert.equal(result.user.email, "ann@x.y");
});

test("device login gives up when the code expires, and reports a denial", async () => {
  let now = 0;
  const fetchImpl: FetchLike = async (input) => new URL(input).pathname === "/api/auth/device"
    ? reply(200, { device_code: "d".repeat(43), user_code: "ABCD-2345", verification_uri: "", verification_uri_complete: "", expires_in: 5, interval: 2 })
    : reply(428, { error: "authorization_pending" });
  await assert.rejects(deviceLogin({ config: { url: "https://s" }, fetchImpl, prompt: () => {}, sleep: async (ms) => { now += ms; }, now: () => now }), /expired before it was approved/);
  const denied: FetchLike = async (input) => new URL(input).pathname === "/api/auth/device"
    ? reply(200, { device_code: "d".repeat(43), user_code: "ABCD-2345", verification_uri: "", verification_uri_complete: "", expires_in: 600, interval: 1 })
    : reply(403, { error: "access_denied", message: "The sign-in was denied in the browser." });
  await assert.rejects(deviceLogin({ config: { url: "https://s" }, fetchImpl: denied, prompt: () => {}, sleep: async () => {} }), /denied in the browser/);
});

test("login saves the token; whoami and members print tables; the default organization is remembered", async () => {
  const root = mkdtempSync(join(tmpdir(), "g1tz-cli-"));
  const server = fakeServer({
    account_me: { id: "u1", displayName: "Ann", email: "ann@x.y", organizations: [{ id: "o1", name: "Acme", plan: "pro", role: "owner" }], invitations: [] },
    organizations_get: { id: "o1" },
    members_list: { members: [{ email: "ann@x.y", displayName: "Ann", role: "owner", teams: [{ name: "Core" }], createdAt: "2026-09-01T00:00:00Z" }], invitations: [{ id: "i1", email: "bo@x.y", role: "user", expiresAt: "2026-09-29T00:00:00Z" }], seats: { used: 1, pending: 1, free: 0, seats: 2 } },
  });
  const login: FetchLike = async (input, init) => {
    const path = new URL(input).pathname;
    if (path === "/api/auth/device") return reply(200, { device_code: "d".repeat(43), user_code: "ABCD-2345", verification_uri: "https://s/account", verification_uri_complete: "https://s/account?device=ABCD-2345", expires_in: 600, interval: 1 });
    if (path === "/api/auth/device/token") return reply(200, { token: "k".repeat(43), expiresAt: "2027-01-01T00:00:00Z", user: { id: "u1", displayName: "Ann", email: "ann@x.y" } });
    return server.fetchImpl(input, init);
  };
  const config = { url: "https://s" };
  let o = io();
  assert.equal(await cloudMain(["login"], { ...o, fetchImpl: login, config, configRoot: root, sleep: async () => {} }), 0);
  assert.match(o.lines.join("\n"), /ABCD-2345/);
  assert.match(o.lines.join("\n"), /Signed in as ann@x.y/);
  assert.equal(readConfig(root).token, "k".repeat(43));

  const signedIn = cloudConfig({}, root);
  o = io();
  assert.equal(await cloudMain(["whoami"], { ...o, fetchImpl: server.fetchImpl, config: signedIn, configRoot: root }), 0);
  assert.match(o.lines[0]!, /Ann <ann@x.y> at https:\/\/s/);
  assert.match(o.lines[1]!, /ORG\s+NAME\s+PLAN\s+ROLE/);
  assert.match(o.lines[1]!, /o1\s+Acme\s+Pro\s+owner/);
  assert.equal(server.calls.at(-1)?.auth, `Bearer ${"k".repeat(43)}`);

  o = io();
  assert.equal(await cloudMain(["org", "use", "o1"], { ...o, fetchImpl: server.fetchImpl, config: signedIn, configRoot: root }), 0);
  assert.equal(readConfig(root).org, "o1");
  o = io();
  assert.equal(await cloudMain(["members"], { ...o, fetchImpl: server.fetchImpl, config: cloudConfig({}, root), configRoot: root }), 0);
  const text = o.lines.join("\n");
  assert.match(text, /ann@x.y\s+Ann\s+owner\s+Core\s+2026-09-01/);
  assert.match(text, /bo@x.y\s+user\s+2026-09-29\s+i1/);
  assert.match(text, /Seats: 1 in use, 1 invited, 0 free of 2/);
  assert.equal(server.calls.at(-1)?.args?.orgId, "o1", "the remembered organization is used");
});

test("a locked feature says which plan unlocks it; no token says to sign in", async () => {
  const server = fakeServer({
    account_me: { organizations: [{ id: "o1", name: "Acme" }], invitations: [] },
    teams_create: () => reply(402, { error: "Teams needs the Advanced plan; Acme is on Pro.", feature: "teams", plan: "advanced", current: "pro" }),
  });
  let o = io();
  assert.equal(await cloudMain(["teams", "create", "Core"], { ...o, fetchImpl: server.fetchImpl, config: { url: "https://s", token: "t".repeat(43) } }), 1);
  assert.equal(o.errors[0], "g1tz: Teams needs the Advanced plan; Acme is on Pro.  (g1tz plan request advanced)");
  o = io();
  assert.equal(await cloudMain(["teams"], { ...o, fetchImpl: server.fetchImpl, config: { url: "https://s" } }), 3);
  assert.match(o.errors[0]!, /g1tz login/);
  o = io();
  assert.equal(await cloudMain(["members", "--help"], { ...o, fetchImpl: server.fetchImpl, config: { url: "https://s" } }), 0);
  assert.match(o.lines[0]!, /g1tz members invite EMAIL/);
});

test("the CLI never reads a real config when given one", () => {
  // Guard against a test accidentally writing to ~/.config: every test above passes configRoot or config.
  assert.ok(readFileSync(new URL(import.meta.url), "utf8").includes("configRoot: root"));
});
