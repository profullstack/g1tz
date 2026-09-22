import { test, expect, beforeAll, afterAll } from "bun:test";
import { firstOrg, harness, type Harness } from "./fixtures.ts";
import { planForProduct } from "../openaccess.ts";

let h: Harness;
beforeAll(async () => { h = await harness(); });
afterAll(() => h.stop());

const post = (body: string, signature?: string) => fetch(`${h.origin}/api/openaccess/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(signature ? { "x-openaccess-signature": signature } : {}) },
  body,
});

test("the descriptor offers one product per paid plan and names the webhook", async () => {
  const response = await fetch(`${h.origin}/.well-known/openaccess.json`);
  expect(response.status).toBe(200);
  const d = await response.json() as { offers: { product: string }[]; honours: string[]; webhooks: { entitlements: string }; hubs: string[] };
  const host = new URL(h.origin).host;
  expect(d.offers.map((o) => o.product)).toEqual([`${host}/pro`, `${host}/advanced`, `${host}/business`, `${host}/enterprise`]);
  expect(d.honours).toEqual(d.offers.map((o) => o.product));
  expect(d.webhooks.entitlements).toBe(`${h.origin}/api/openaccess/webhook`);
  expect(planForProduct(h.origin, `${host}/business`)).toBe("business");
  expect(planForProduct(h.origin, `${host}/community`)).toBeNull();
  expect(planForProduct(h.origin, "elsewhere.test/pro")).toBeNull();
});

test("an entitlement moves the linked organization between plans; a lapse drops it back", async () => {
  const owner = await h.signIn("pay@shop.test");
  const org = await firstOrg(owner);
  const event = (status: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    event: "entitlement.updated",
    entitlement: { principal: "oa_shop_person_1", product: `${new URL(h.origin).host}/advanced`, status, ...extra },
  });

  const unsigned = await post(event("active"));
  expect(unsigned.status).toBe(401);
  const forged = await post(event("active"), "ed25519=" + Buffer.alloc(64).toString("base64"));
  expect(forged.status).toBe(401);

  const unlinked = await post(event("active"), h.sign(event("active")));
  expect(unlinked.status).toBe(202);
  expect(((await unlinked.json()) as { unlinked: string }).unlinked).toBe("oa_shop_person_1");

  await owner.call("organizations_link", { orgId: org.id, principal: "oa_shop_person_1" });
  const body = event("active", { quantity: 25 });
  const applied = await post(body, h.sign(body));
  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({ orgId: org.id, plan: "advanced", seats: 10 });
  const plan = await owner.call<{ plan: string; seats: { seats: number }; entitlement: { source: string; status: string } }>("plan_get", { orgId: org.id });
  expect(plan.plan).toBe("advanced");
  expect(plan.seats.seats).toBe(10);
  expect(plan.entitlement).toMatchObject({ source: "openaccess", status: "active" });

  // Now that the plan allows it, a team can exist.
  await owner.call("teams_create", { orgId: org.id, name: "Shop" });

  const lapse = event("cancelled");
  const lapsed = await post(lapse, h.sign(lapse));
  expect(await lapsed.json()).toMatchObject({ plan: "community", seats: 1 });
  const after = await owner.call<{ plan: string }>("plan_get", { orgId: org.id });
  expect(after.plan).toBe("community");
  const audit = await owner.call<{ action: string; actor: string | null }[]>("audit_list", { orgId: org.id });
  expect(audit.map((a) => a.action).slice(0, 3)).toEqual(["plan.lapsed", "team.create", "plan.entitled"]);
  expect(audit[0]!.actor).toBeNull();

  const other = JSON.stringify({ event: "entitlement.updated", entitlement: { principal: "oa_shop_person_1", product: "elsewhere.test/pro", status: "active" } });
  const ignored = await post(other, h.sign(other));
  expect(await ignored.json()).toMatchObject({ ignored: "not our product" });
});
