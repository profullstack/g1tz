/**
 * The Team screen: the organization this terminal belongs to, its members and
 * roles, teams, shared workspaces, and what the plan unlocks. Read-only here;
 * every change is a `g1tz members …` or `g1tz teams …` command, and the status
 * bar says so.
 *
 * `teamView` is pure: it draws from `TeamState` only, so tests assert on the
 * rendered text. `loadTeam` fills the state off the render loop with a ticket,
 * the way the Pulse screen reads GitHub.
 */
import type { Container, Theme } from "@profullstack/hqtui";
import { cloudAction, type FetchLike } from "./cloud-client.ts";
import type { CloudConfig } from "./account.ts";
import { PLAN_SPECS, type Entitlement, type Plan, type Role, type SeatUsage } from "./teams-model.ts";

export type TeamStatus = "signed-out" | "loading" | "ready" | "error";
export type TeamPane = "members" | "teams" | "workspaces";

export interface TeamMember { email: string; displayName: string; role: Role; teams: { id: string; name: string }[] }
export interface TeamTeam { id: string; name: string; members: number; member: boolean }
export interface TeamWorkspace { id: string; name: string; team: string | null; description: string; repos: { url: string; name: string }[] }
export interface TeamData {
  me: { email: string; displayName: string };
  org: { id: string; name: string; plan: Plan; role: Role; seats: SeatUsage; domains: string[] };
  members: TeamMember[];
  invitations: { email: string; role: Role }[];
  teams: TeamTeam[];
  workspaces: TeamWorkspace[];
  entitlements: Entitlement[];
}

export interface TeamState {
  status: TeamStatus;
  note: string;
  url: string;
  data: TeamData | null;
  pane: TeamPane;
  selected: Record<TeamPane, number>;
  offset: Record<TeamPane, number>;
  request: number;
}

export function createTeamState(url = ""): TeamState {
  return { status: "signed-out", note: "", url, data: null, pane: "members", selected: { members: 0, teams: 0, workspaces: 0 }, offset: { members: 0, teams: 0, workspaces: 0 }, request: 0 };
}

export interface TeamActions {
  back: () => void;
  refresh: () => void;
}
export const NO_TEAM_ACTIONS: TeamActions = { back: () => {}, refresh: () => {} };

const PANES: TeamPane[] = ["members", "teams", "workspaces"];

export function cyclePane(state: TeamState): void {
  state.pane = PANES[(PANES.indexOf(state.pane) + 1) % PANES.length] as TeamPane;
}

function count(state: TeamState, pane: TeamPane): number {
  const d = state.data;
  if (!d) return 0;
  return pane === "members" ? d.members.length : pane === "teams" ? d.teams.length : d.workspaces.length;
}

export function moveTeam(state: TeamState, delta: number): void {
  const total = count(state, state.pane);
  if (total === 0) return;
  state.selected[state.pane] = Math.max(0, Math.min(total - 1, state.selected[state.pane] + delta));
}

/**
 * Read everything the screen shows. A reply for an older ticket (refresh
 * pressed twice) is dropped. Without a token the screen says how to sign in.
 */
export async function loadTeam(state: TeamState, config: CloudConfig, onChange: () => void, fetchImpl: FetchLike = fetch): Promise<void> {
  const ticket = ++state.request;
  state.url = config.url;
  if (!config.token) {
    state.status = "signed-out";
    state.data = null;
    onChange();
    return;
  }
  state.status = "loading";
  state.note = "";
  onChange();
  try {
    const me = await cloudAction<{ email: string; displayName: string; organizations: { id: string; name: string }[] }>("account_me", {}, config, fetchImpl);
    const orgId = config.org && me.organizations.some((o) => o.id === config.org) ? config.org : me.organizations[0]?.id;
    if (!orgId) throw new Error("You are in no organization yet: g1tz org create NAME");
    const [org, members, teams, workspaces, plan] = await Promise.all([
      cloudAction<TeamData["org"]>("organizations_get", { orgId }, config, fetchImpl),
      cloudAction<{ members: TeamMember[]; invitations: { email: string; role: Role }[] }>("members_list", { orgId }, config, fetchImpl),
      cloudAction<TeamTeam[]>("teams_list", { orgId }, config, fetchImpl),
      cloudAction<TeamWorkspace[]>("workspaces_list", { orgId }, config, fetchImpl),
      cloudAction<{ entitlements: Entitlement[] }>("plan_get", { orgId }, config, fetchImpl),
    ]);
    if (ticket !== state.request) return;
    state.data = { me: { email: me.email, displayName: me.displayName }, org, members: members.members, invitations: members.invitations, teams, workspaces, entitlements: plan.entitlements };
    for (const pane of PANES) state.selected[pane] = Math.max(0, Math.min(count(state, pane) - 1, state.selected[pane]));
    state.status = "ready";
  } catch (error) {
    if (ticket !== state.request) return;
    const status = (error as { status?: number }).status;
    state.status = status === 401 ? "signed-out" : "error";
    state.note = error instanceof Error ? error.message : String(error);
    if (status === 401) state.data = null;
  }
  onChange();
}

export interface TeamViewArgs {
  ui: Container;
  theme: Theme;
  width: number;
  height: number;
}

const capital = (value: string) => `${value[0]!.toUpperCase()}${value.slice(1)}`;

const roleColor = (theme: Theme, role: Role): number =>
  role === "owner" ? theme.title : role === "admin" ? theme.accent : role === "lead" ? theme.success : role === "billing" ? theme.warning : theme.foreground;

export function teamView({ ui, theme, height }: TeamViewArgs, state: TeamState, actions: TeamActions = NO_TEAM_ACTIONS): void {
  const d = state.data;
  ui.row({ size: 1 }, (header) => {
    header.text(" g1tz teams", { fg: theme.title, bold: true, size: 12 });
    if (d) {
      header.text(d.org.name, { fg: theme.accent, size: Math.max(12, d.org.name.length + 2) });
      header.text(`${PLAN_SPECS[d.org.plan].name}  ${d.org.seats.used}/${d.org.seats.seats} seats  you: ${d.org.role}`, { fg: theme.muted });
    } else header.text(state.status === "loading" ? "loading…" : "", { fg: theme.muted });
    header.text(`${state.url}  Tab panes  r refresh  t back `, { fg: theme.muted, align: "right" });
  });

  ui.row({ size: height - 2, gap: 1 }, (row) => {
    if (!d) {
      row.panel({ title: state.status === "error" ? "Could not read the organization" : "Sign in", width: "1fr" }, (p) => {
        if (state.status === "loading") { p.label("Reading the organization…"); return; }
        if (state.status === "error") { p.text(state.note, { fg: theme.danger, size: 1 }); p.label(" "); p.label("Press r to try again."); return; }
        if (state.note) p.text(state.note, { fg: theme.warning, size: 1 });
        p.label("This terminal is not signed in.");
        p.label(" ");
        p.label("In another terminal:   g1tz login");
        p.label("then press r here.");
        p.label(" ");
        p.text("Teams give you an organization with Owner, Admin, Lead, User and Billing Contact roles,", { fg: theme.muted, size: 1 });
        p.text("seats, teams, shared workspaces and an audit log. Community is free for one seat.", { fg: theme.muted, size: 1 });
      });
      return;
    }
    row.column({ width: "1fr", gap: 1 }, (left) => {
      left.panel({
        title: `Members (${d.members.length}${d.invitations.length ? `, ${d.invitations.length} invited` : ""})`,
        size: "1.4fr",
        borderColor: state.pane === "members" ? theme.borderFocused : theme.border,
      }, (p) => {
        p.table({
          rows: [
            ...d.members.map((m) => ({ email: m.email, role: m.role, teams: m.teams.map((t) => t.name).join(", "), m })),
            ...d.invitations.map((i) => ({ email: i.email, role: i.role, teams: "invited", m: null })),
          ],
          selected: state.selected.members,
          offset: state.offset.members,
          followSelection: true,
          scrollbar: true,
          onScroll: (delta) => { state.offset.members = Math.max(0, state.offset.members + delta); },
          header: false,
          columns: [
            { key: "email", title: "", min: 8, color: (r) => (r.m ? theme.foreground : theme.muted) },
            { key: "role", title: "", width: 8, color: (r) => roleColor(theme, r.role as Role) },
            { key: "teams", title: "", min: 6, color: theme.muted },
          ],
        });
      });
      left.panel({
        title: `Teams (${d.teams.length})`,
        size: "1fr",
        borderColor: state.pane === "teams" ? theme.borderFocused : theme.border,
      }, (p) => {
        const lock = d.entitlements.find((e) => e.feature === "teams");
        if (d.teams.length === 0) {
          p.label(lock && !lock.unlocked ? `🔒 Teams need the ${PLAN_SPECS[lock.plan].name} plan.` : "No teams yet: g1tz teams create NAME");
          return;
        }
        p.list({
          items: d.teams.map((t) => `${t.member ? "* " : "  "}${t.name}  ${t.members} member${t.members === 1 ? "" : "s"}`),
          selected: state.selected.teams,
          offset: state.offset.teams,
          scrollbar: true,
          onScroll: (delta) => { state.offset.teams = Math.max(0, state.offset.teams + delta); },
        });
      });
    });

    row.column({ width: "1.3fr", gap: 1 }, (right) => {
      right.panel({
        title: `Workspaces (${d.workspaces.length})`,
        size: "1.2fr",
        borderColor: state.pane === "workspaces" ? theme.borderFocused : theme.border,
      }, (p) => {
        const lock = d.entitlements.find((e) => e.feature === "workspaces.shared");
        if (d.workspaces.length === 0) {
          p.label(lock && !lock.unlocked ? `🔒 Shared workspaces need the ${PLAN_SPECS[lock.plan].name} plan.` : "No workspaces yet: g1tz workspaces create NAME");
          return;
        }
        // Text rather than a list widget: each workspace is a heading with its
        // repositories under it, and the selected one is the one drawn bright.
        d.workspaces.forEach((s, index) => {
          const current = index === state.selected.workspaces;
          p.text(`${current ? "▸ " : "  "}${s.name}${s.team ? `  (${s.team})` : ""}  ${s.repos.length} repo${s.repos.length === 1 ? "" : "s"}`, { fg: current ? theme.accent : theme.foreground, bold: current, size: 1 });
          if (!current) return;
          for (const r of s.repos.slice(0, 8)) p.text(`    ${r.name}  ${r.url}`, { fg: theme.muted, size: 1 });
          if (s.repos.length > 8) p.text(`    … ${s.repos.length - 8} more`, { fg: theme.muted, size: 1 });
        });
      });
      right.panel({ title: `Plan: ${PLAN_SPECS[d.org.plan].name}`, size: "1fr" }, (p) => {
        const s = d.org.seats;
        p.text(`${s.used} in use, ${s.pending} invited, ${s.free} free of ${s.seats}${s.cap === null ? "" : ` (cap ${s.cap})`}`, { fg: theme.foreground, size: 1 });
        if (d.org.domains.length) p.text(`domains: ${d.org.domains.join(", ")}`, { fg: theme.muted, size: 1 });
        // The plan that unlocks a feature comes first, so a narrow panel cuts
        // the description and never the answer.
        for (const e of d.entitlements) {
          // The lock is two cells wide and the check one; the extra space keeps the plan column straight.
          p.text(e.unlocked ? `✓  ${capital(e.plan).padEnd(10)} ${e.line}` : `🔒 ${capital(e.plan).padEnd(10)} ${e.line}`, { fg: e.unlocked ? theme.success : theme.muted, size: 1 });
        }
      });
    });
  });

  ui.statusBar({
    items: [
      { key: "Tab", label: state.pane, active: true },
      { key: "↑↓", label: "Move" },
      { key: "r", label: "Refresh", onPress: actions.refresh },
      { key: "t", label: "Back", onPress: actions.back },
      { key: "Ctrl+C", label: "Quit" },
    ],
    right: [{ label: d ? `${d.me.email}  changes: g1tz members|teams|workspaces …` : state.note }],
  });
}
