import { test } from "node:test";
import assert from "node:assert/strict";
import { atLeast, can, entitlements, FEATURE_KEYS, hasFeature, PLANS, planFor, ROLES, seatUsage } from "../src/teams-model.ts";

test("the role matrix matches the one a GitKraken team knows", () => {
  assert.deepEqual(ROLES, ["owner", "admin", "lead", "user", "billing"]);
  assert.equal(can("owner", "transferOwnership"), true);
  assert.equal(can("admin", "transferOwnership"), false);
  assert.equal(can("admin", "manageUsers"), true);
  assert.equal(can("lead", "manageUsers"), false);
  assert.equal(can("lead", "manageTeams"), true);
  assert.equal(can("lead", "insights"), true);
  assert.equal(can("user", "manageTeams"), false);
  assert.equal(can("billing", "billing"), true);
  assert.equal(can("billing", "manageUsers"), false);
  assert.equal(can(undefined, "billing"), false);
});

test("every role but the Billing Contact holds a seat, and invitations hold one too", () => {
  const usage = seatUsage("pro", 2, [{ role: "owner" }, { role: "billing" }], [{ role: "user" }, { role: "billing" }]);
  assert.deepEqual(usage, { used: 1, pending: 1, seats: 2, cap: 2, free: 0 });
  assert.deepEqual(seatUsage("enterprise", 500, [{ role: "owner" }]), { used: 1, pending: 0, seats: 500, cap: null, free: 499 });
  assert.equal(seatUsage("advanced", 50, []).seats, 10, "the plan caps the seats an organization can claim");
  assert.equal(seatUsage("community", 1, [{ role: "owner" }]).free, 0);
});

test("tiers nest: what Pro has, Advanced has", () => {
  assert.deepEqual(PLANS, ["community", "pro", "advanced", "business", "enterprise"]);
  for (let i = 1; i < PLANS.length; i++) {
    for (const feature of FEATURE_KEYS) {
      if (hasFeature(PLANS[i - 1]!, feature)) assert.equal(hasFeature(PLANS[i]!, feature), true, `${PLANS[i]} lost ${feature}`);
    }
  }
  assert.equal(hasFeature("community", "members.invite"), false);
  assert.equal(hasFeature("pro", "members.invite"), true);
  assert.equal(hasFeature("pro", "teams"), false);
  assert.equal(planFor("teams"), "advanced");
  assert.equal(planFor("insights"), "business");
  assert.equal(atLeast("business", "pro"), true);
  assert.equal(atLeast("pro", "business"), false);
  const card = entitlements("advanced");
  assert.equal(card.length, FEATURE_KEYS.length);
  assert.deepEqual(card.filter((e) => !e.unlocked).map((e) => e.feature), ["sso.domains", "insights", "audit.export", "support.sla"]);
});
