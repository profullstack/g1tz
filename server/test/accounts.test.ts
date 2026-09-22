import { test, expect, beforeAll, afterAll } from "bun:test";
import { harness, type Harness } from "./fixtures.ts";

let h: Harness;
beforeAll(async () => { h = await harness(); });
afterAll(() => h.stop());

test("a mailbox becomes an account with a personal organization on the free plan", async () => {
  const ann = await h.signIn("ann@example.com");
  const me = await ann.call<{ email: string; organizations: { plan: string; role: string; name: string }[] }>("account_me");
  expect(me.email).toBe("ann@example.com");
  expect(me.organizations).toHaveLength(1);
  expect(me.organizations[0]).toMatchObject({ plan: "community", role: "owner", name: "ann's organization" });
  const session = await ann.fetch("/api/auth/session");
  expect(((await session.json()) as { user: { email: string } }).user.email).toBe("ann@example.com");
});

test("the sign-in mail is the credential: a bad token is refused, a used one is gone", async () => {
  const refused = await h.anonymous().auth("verify", { token: "x".repeat(43) });
  expect(refused.status).toBe(400);
  const sent = await h.anonymous().auth("email", { email: "bo@example.com" });
  expect(sent.status).toBe(200);
  const token = h.mails.signIn.at(-1)!.url.split("#verify=")[1]!;
  const first = await h.anonymous().auth("verify", { token });
  expect(first.status).toBe(200);
  const again = await h.anonymous().auth("verify", { token });
  expect(again.status).toBe(400);
});

test("a mail that bounces never looks like a sign-in", async () => {
  const sent = await h.anonymous().auth("email", { email: "nobody@bounce.test" });
  expect(sent.status).toBe(503);
});

test("browser writes need a same-origin Origin header; a bearer token does not", async () => {
  const cat = await h.signIn("cat@example.com");
  const crossSite = await cat.fetch("/api/v1/actions", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ operation: "account_me", args: {} }) });
  expect(crossSite.status).toBe(403);
  const noOrigin = await cat.fetch("/api/v1/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "account_me", args: {} }) });
  expect(noOrigin.status).toBe(403);
  const token = await cat.call<{ token: string }>("tokens_create", { label: "ci" });
  const bearer = h.bearer(token.token);
  const viaToken = await bearer.fetch("/api/v1/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "account_me", args: {} }) });
  expect(viaToken.status).toBe(200);
  const tokens = await cat.call<{ label: string; kind: string }[]>("tokens_list");
  expect(tokens.map((t) => t.label)).toContain("ci");
});

test("device login: the terminal polls, the browser approves, the terminal gets a token", async () => {
  const start = await h.anonymous().auth("device", { label: "dev box" });
  expect(start.status).toBe(200);
  expect(start.body.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(start.body.verification_uri_complete).toBe(`${h.origin}/account?device=${start.body.user_code}`);
  const pending = await h.anonymous().auth("device/token", { device_code: start.body.device_code });
  expect(pending.status).toBe(428);
  expect(pending.body.error).toBe("authorization_pending");

  const dee = await h.signIn("dee@example.com");
  const preview = await dee.auth("device/preview", { code: (start.body.user_code as string).toLowerCase().replace("-", " ") });
  expect(preview.status).toBe(200);
  expect(preview.body.label).toBe("dev box");
  const approved = await dee.auth("device/approve", { code: start.body.user_code });
  expect(approved.status).toBe(200);

  const done = await h.anonymous().auth("device/token", { device_code: start.body.device_code });
  expect(done.status).toBe(200);
  expect((done.body.user as { email: string }).email).toBe("dee@example.com");
  const terminal = h.bearer(done.body.token as string);
  const me = await terminal.call<{ email: string }>("account_me");
  expect(me.email).toBe("dee@example.com");
  // The code is spent.
  const spent = await h.anonymous().auth("device/token", { device_code: start.body.device_code });
  expect(spent.status).toBe(410);
  const sessions = await terminal.call<{ kind: string; label: string }[]>("tokens_list");
  expect(sessions).toContainEqual(expect.objectContaining({ kind: "device", label: "dev box" }));
});

test("device login can be denied, and an unknown code is not approvable", async () => {
  const start = await h.anonymous().auth("device", {});
  const eve = await h.signIn("eve@example.com");
  const unknown = await eve.auth("device/approve", { code: "ZZZZ-ZZZZ" });
  expect(unknown.status).toBe(404);
  const denied = await eve.auth("device/deny", { code: start.body.user_code });
  expect(denied.status).toBe(200);
  const poll = await h.anonymous().auth("device/token", { device_code: start.body.device_code });
  expect(poll.status).toBe(403);
  expect(poll.body.error).toBe("access_denied");
});

test("approving a device needs a signed-in browser", async () => {
  const start = await h.anonymous().auth("device", {});
  const anon = await h.anonymous().auth("device/approve", { code: start.body.user_code });
  expect(anon.status).toBe(401);
});

test("logout ends the session", async () => {
  const fay = await h.signIn("fay@example.com");
  await fay.auth("logout", {});
  const after = await fay.fetch("/api/v1/me");
  expect(((await after.json()) as { user: unknown }).user).toBeNull();
});
