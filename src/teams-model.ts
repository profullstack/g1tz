/**
 * The teams model: plans, roles, what each role may do, what each plan
 * unlocks, and how seats are counted. Pure, shared by the server, the CLI and
 * the Team screen, so a lock the terminal shows is the same lock the server
 * enforces.
 *
 * The shape follows GitKraken's organization model so a team moving over finds
 * the words it knows: one Owner, Admins, Leads, Users and a Billing Contact;
 * every role but Billing Contact consumes a seat; Community, Pro, Advanced,
 * Business and Enterprise tiers.
 */

export const PLANS = ["community", "pro", "advanced", "business", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export const ROLES = ["owner", "admin", "lead", "user", "billing"] as const;
export type Role = (typeof ROLES)[number];

export interface PlanSpec {
  name: string;
  rank: number;
  /** The most seats the tier allows; null is unlimited. */
  seatCap: number | null;
  /** Free-form, for the plan card. */
  price: string;
}

export const PLAN_SPECS: Record<Plan, PlanSpec> = {
  community: { name: "Community", rank: 0, seatCap: 1, price: "free, one seat" },
  pro: { name: "Pro", rank: 1, seatCap: 2, price: "per seat, up to 2" },
  advanced: { name: "Advanced", rank: 2, seatCap: 10, price: "per seat, up to 10" },
  business: { name: "Business", rank: 3, seatCap: 100, price: "per seat, up to 100" },
  enterprise: { name: "Enterprise", rank: 4, seatCap: null, price: "custom" },
};

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Every feature a plan can unlock, with the lowest tier that has it. */
export const FEATURES = {
  "members.invite": { plan: "pro", line: "Invite people and assign roles" },
  "workspaces.shared": { plan: "pro", line: "Shared workspaces for the whole organization" },
  "teams": { plan: "advanced", line: "Teams, and workspaces only a team sees" },
  "sso.domain": { plan: "advanced", line: "One verified email domain joins on sign-in" },
  "sso.domains": { plan: "business", line: "Any number of verified email domains" },
  "insights": { plan: "business", line: "Insights and the Lead role" },
  "audit.export": { plan: "business", line: "Audit log export" },
  "support.sla": { plan: "enterprise", line: "Custom contract and a support SLA" },
} as const satisfies Record<string, { plan: Plan; line: string }>;

export type Feature = keyof typeof FEATURES;

export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

export function hasFeature(plan: Plan, feature: Feature): boolean {
  return PLAN_SPECS[plan].rank >= PLAN_SPECS[FEATURES[feature].plan].rank;
}

export interface Entitlement {
  feature: Feature;
  line: string;
  /** The lowest plan that has it. */
  plan: Plan;
  unlocked: boolean;
}

/** The whole feature list for a plan, unlocked or not, for a plan card. */
export function entitlements(plan: Plan): Entitlement[] {
  return FEATURE_KEYS.map((feature) => ({
    feature,
    line: FEATURES[feature].line,
    plan: FEATURES[feature].plan,
    unlocked: hasFeature(plan, feature),
  }));
}

/** The lowest plan that unlocks a feature, for the "needs Pro" line. */
export function planFor(feature: Feature): Plan {
  return FEATURES[feature].plan;
}

/** What a member may do, by role. */
export const ACTIONS = {
  manageUsers: ["owner", "admin"],
  manageTeams: ["owner", "admin", "lead"],
  manageWorkspaces: ["owner", "admin", "lead"],
  billing: ["owner", "admin", "billing"],
  insights: ["owner", "admin", "lead"],
  audit: ["owner", "admin"],
  transferOwnership: ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof ACTIONS;

export function can(role: Role | null | undefined, action: Action): boolean {
  return !!role && (ACTIONS[action] as readonly Role[]).includes(role);
}

/** The Billing Contact is the one role that does not consume a seat. */
export const consumesSeat = (role: Role): boolean => role !== "billing";

export interface SeatUsage {
  /** Members holding a seat. */
  used: number;
  /** Invitations that will hold one when accepted. */
  pending: number;
  /** Seats the organization has. */
  seats: number;
  /** What the plan allows at most; null is unlimited. */
  cap: number | null;
  free: number;
}

export function seatUsage(
  plan: Plan,
  seats: number,
  members: readonly { role: Role }[],
  invitations: readonly { role: Role }[] = [],
): SeatUsage {
  const cap = PLAN_SPECS[plan].seatCap;
  const allowed = cap === null ? seats : Math.min(seats, cap);
  const used = members.filter((m) => consumesSeat(m.role)).length;
  const pending = invitations.filter((i) => consumesSeat(i.role)).length;
  return { used, pending, seats: allowed, cap, free: Math.max(0, allowed - used - pending) };
}

/** A role's line for a table or a select. */
export const ROLE_LINES: Record<Role, string> = {
  owner: "Owner: everything, including transferring ownership. One per organization.",
  admin: "Admin: manage users, teams, billing and insights; cannot change or remove the owner.",
  lead: "Lead: manage teams and read insights. Needs Insights (Business).",
  user: "User: a seat, no administration.",
  billing: "Billing Contact: billing settings and invoices. Does not consume a seat.",
};

export const PLAN_LINES: Record<Plan, string> = {
  community: "Community: local and public repositories, one seat, no organization management.",
  pro: "Pro: invite up to 2 users, assign roles, shared workspaces.",
  advanced: "Advanced: up to 10 seats, teams and team workspaces, one verified domain.",
  business: "Business: up to 100 seats, many verified domains, Insights and the Lead role, audit export.",
  enterprise: "Enterprise: unlimited seats, custom contract, support SLA.",
};

/** Ranks compare plans: is `plan` at least `minimum`? */
export function atLeast(plan: Plan, minimum: Plan): boolean {
  return PLAN_SPECS[plan].rank >= PLAN_SPECS[minimum].rank;
}
