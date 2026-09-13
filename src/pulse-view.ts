/**
 * The Pulse screen: what moved in this repository over a period.
 *
 * Git on the left (overview, commits over time, authors), the wider world on
 * the right (the files that changed, GitHub's pull requests, issues, releases
 * and stars, and the repository's views and clones from a gh-pulse report).
 * Pure: everything drawn comes from PulseState, so the screen is asserted on
 * as text in the tests and captured for the hqtui.com gallery the same way.
 */
import { widgets, type Container, type Theme } from "@profullstack/hqtui";
import type { GitHubPulse } from "./github.ts";
import { RANGE_KEYS, RANGE_LABEL, foldBuckets, type Pulse, type PulseRef, type RangeKey } from "./pulse.ts";
import type { Traffic, TrafficDay } from "./traffic.ts";

export type GitHubStatus = "idle" | "loading" | "ready" | "unavailable";

export interface PulseState {
  range: RangeKey;
  data: Pulse | null;
  github: GitHubPulse | null;
  githubStatus: GitHubStatus;
  /** Why GitHub is unavailable, when it is. */
  githubNote: string;
  /** Ticket of the latest GitHub request; a reply to an older one is dropped. */
  githubRequest: number;
  traffic: Traffic | null;
  filesOffset: number;
  note: string;
}

export function createPulseState(range: RangeKey = "week"): PulseState {
  return {
    range,
    data: null,
    github: null,
    githubStatus: "idle",
    githubNote: "",
    githubRequest: 0,
    traffic: null,
    filesOffset: 0,
    note: "",
  };
}

export interface PulseActions {
  pickRange: (key: RangeKey) => void;
  refresh: () => void;
  /** Back to the repository screen. */
  back: () => void;
  /** Open the Pulse screen from the repository screen. */
  pulse: () => void;
}

export const NO_ACTIONS: PulseActions = { pickRange: () => {}, refresh: () => {}, back: () => {}, pulse: () => {} };

export interface ViewArgs {
  ui: Container;
  theme: Theme;
  width: number;
  height: number;
  elapsed: number;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtStamp = (iso: string): string => iso.replace("T", " ").slice(0, 16);
const names = (refs: readonly PulseRef[], max: number): string =>
  `${refs.slice(0, max).map((r) => r.name).join(", ")}${refs.length > max ? ", …" : ""}`;

/** Keep the tail of a path, which is the part that tells files apart; the library's own truncation keeps the head. */
export function shortenPath(path: string, max: number): string {
  if (max < 4 || path.length <= max) return path;
  return `…${path.slice(path.length - (max - 1))}`;
}

export const clampOffset = (offset: number, total: number): number => Math.max(0, Math.min(Math.max(0, total - 1), offset));

/**
 * Content columns of the two panes: the body splits 1fr : 1.2fr with a gap of
 * one, and a panel's border and padding take two on each side. An estimate,
 * since the layout is not known until it is solved; a column short is fine,
 * a column over is a truncated axis label.
 */
export const leftPaneColumns = (width: number): number => Math.max(10, Math.floor((width - 1) / 2.2) - 4);
export const rightPaneColumns = (width: number): number => Math.max(10, Math.floor(((width - 1) * 1.2) / 2.2) - 4);

export function commitTotals(pulse: Pulse): { commits: number; merges: number } {
  let merges = 0;
  for (const c of pulse.commits) if (c.merge) merges++;
  return { commits: pulse.commits.length - merges, merges };
}

/** What the status bar says on the right: the GitHub read, or nothing. */
export function githubLine(state: PulseState, elapsed: number): string {
  switch (state.githubStatus) {
    case "loading": return `${widgets.spinnerFrame(elapsed, widgets.SPINNER_FRAMES.dots)} GitHub`;
    case "unavailable": return `GitHub: ${state.githubNote}`;
    case "ready": return state.github?.partial ? "GitHub counts are floors (page budget)" : "";
    default: return "";
  }
}

function overviewPanel(col: Container, theme: Theme, pulse: Pulse | null): void {
  col.panel({ title: "Overview", size: 9 }, (p) => {
    if (!pulse) {
      p.label("Press r to read the repository.");
      return;
    }
    const { commits, merges } = commitTotals(pulse);
    const authors = pulse.authors;
    p.keyValues([
      {
        label: "Commits",
        value: `${commits} on ${pulse.branch || "HEAD"}${merges ? `, ${plural(merges, "merge")}` : ""}${pulse.commitsTruncated ? " (capped)" : ""}`,
        color: theme.accent,
      },
      { label: "All branches", value: `${plural(pulse.allBranchCommits, "commit")}, merges excluded` },
      {
        label: "Authors",
        value: authors.length ? `${authors.length}: ${authors.slice(0, 3).map((a) => a.name).join(", ")}${authors.length > 3 ? ", …" : ""}` : "none",
      },
      { label: "Changed", value: `${plural(pulse.filesChanged, "file")}, +${pulse.additions} −${pulse.deletions}`, color: theme.success },
      { label: "Branches", value: pulse.branches.length ? `${pulse.branches.length} active: ${names(pulse.branches, 3)}` : "none active" },
      { label: "Tags", value: pulse.tags.length ? `${pulse.tags.length} new: ${names(pulse.tags, 4)}` : "none" },
      { label: "Period", value: `${pulse.since ? fmtStamp(pulse.since) : "the first commit"} to ${fmtStamp(pulse.until)}` },
    ]);
  });
}

function activityPanel(col: Container, theme: Theme, pulse: Pulse | null, label: string, cols: number): void {
  col.panel({ title: pulse ? `Commits per ${pulse.unit}` : "Commits", size: 8 }, (p) => {
    if (!pulse) return;
    const buckets = foldBuckets(pulse.buckets, Math.max(1, Math.floor(cols / 2)));
    const peak = buckets.reduce((m, b) => Math.max(m, b.count), 0);
    if (peak === 0) {
      p.label(`No commits, ${label}.`);
      return;
    }
    // Each bucket is widened to fill the pane, as one column per bucket would leave most of it empty.
    const per = Math.max(1, Math.floor(cols / Math.max(1, buckets.length)));
    p.text(`${plural(pulse.commits.length, "commit")}, peak ${peak} in one ${pulse.unit}`, { fg: theme.muted, size: 1 });
    p.histogram({ values: buckets.flatMap((b) => Array<number>(per).fill(b.count)), color: theme.accent, size: 4 });
    const first = buckets[0]?.label ?? "";
    const last = buckets.at(-1)?.label ?? "";
    p.text(`${first}${" ".repeat(Math.max(1, cols - first.length - last.length))}${last}`, { fg: theme.muted, size: 1 });
  });
}

function authorsPanel(col: Container, theme: Theme, pulse: Pulse | null, label: string): void {
  col.panel({ title: `Authors (${pulse?.authors.length ?? 0})`, size: "1fr" }, (p) => {
    if (!pulse || pulse.authors.length === 0) {
      p.label(`No commits, ${label}.`);
      return;
    }
    const total = pulse.authors.reduce((t, a) => t + a.commits, 0);
    p.table({
      rows: pulse.authors,
      header: false,
      scrollbar: true,
      columns: [
        { key: "name", title: "", min: 8, color: theme.foreground },
        { key: "commits", title: "", width: 6, align: "right", color: theme.accent, render: (a) => String(a.commits) },
        {
          key: "share",
          title: "",
          width: 16,
          color: theme.muted,
          render: (a) => {
            const filled = Math.round((a.commits / total) * 10);
            return `${"█".repeat(filled)}${"·".repeat(10 - filled)} ${Math.round((100 * a.commits) / total)}%`;
          },
        },
      ],
    });
  });
}

function filesPanel(col: Container, theme: Theme, state: PulseState, label: string, cols: number): void {
  const pulse = state.data;
  const title = pulse ? `Files changed (${pulse.filesChanged})  +${pulse.additions} −${pulse.deletions}` : "Files changed";
  col.panel({ title, size: "1fr" }, (p) => {
    if (!pulse || pulse.files.length === 0) {
      p.label(`Nothing changed, ${label}.`);
      return;
    }
    const pathWidth = Math.max(8, cols - 16);
    p.table({
      rows: pulse.files,
      offset: state.filesOffset,
      header: false,
      scrollbar: true,
      onScroll: (delta) => { state.filesOffset = clampOffset(state.filesOffset + delta, pulse.files.length); },
      columns: [
        { key: "path", title: "", min: 8, color: theme.foreground, render: (f) => shortenPath(f.from ? `${f.from} → ${f.path}` : f.path, pathWidth) },
        { key: "added", title: "", width: 7, align: "right", color: theme.success, render: (f) => (f.binary ? "bin" : `+${f.added}`) },
        { key: "deleted", title: "", width: 7, align: "right", color: theme.danger, render: (f) => (f.binary ? "" : `−${f.deleted}`) },
      ],
    });
  });
}

function githubPanel(col: Container, theme: Theme, state: PulseState, label: string, elapsed: number): void {
  const g = state.github;
  col.panel({ title: g ? `GitHub  ${g.repo}` : "GitHub", size: 10 }, (p) => {
    if (state.githubStatus === "loading") {
      p.spinner({ label: "asking GitHub", text: label, elapsed });
      return;
    }
    if (state.githubStatus !== "ready" || !g) {
      p.text(state.githubNote || "Pull requests, issues, releases and stars appear here when gh is logged in.", { fg: theme.muted, wrap: true });
      return;
    }
    p.keyValues([
      {
        label: "Pull requests",
        value: `${g.prsMerged.length} merged, ${g.prsOpened.length} opened, ${g.prsClosed.length} closed unmerged`,
        color: theme.accent,
      },
      { label: "Issues", value: `${g.issuesOpened.length} opened, ${g.issuesClosed.length} closed, ${g.openIssues} open now` },
      { label: "Releases", value: g.releases.length ? `${g.releases.length}: ${g.releases.slice(0, 4).map((r) => r.tag).join(", ")}` : "none" },
      { label: "Stars", value: `+${g.newStars}${g.partial ? " or more" : ""}, ${g.stars} total, ${plural(g.forks, "fork")}` },
    ]);
    const lines: string[] = [];
    for (const pr of g.prsMerged.slice(0, 2)) lines.push(`merged #${pr.number} ${pr.title} (${pr.user})`);
    for (const pr of g.prsOpened.slice(0, 1)) lines.push(`opened #${pr.number} ${pr.title} (${pr.user})`);
    for (const is of g.issuesOpened.slice(0, 1)) lines.push(`issue #${is.number} ${is.title} (${is.user})`);
    if (lines.length) p.text(lines.join("\n"), { fg: theme.muted });
  });
}

function trafficPanel(col: Container, theme: Theme, t: Traffic | null): void {
  col.panel({ title: t ? `Traffic  gh-pulse ${fmtStamp(t.reportAt)}` : "Traffic", size: 7 }, (p) => {
    if (!t) {
      p.text("Views and clones appear here when a gh-pulse report exists on this machine (~/.local/share/gh-pulse).", { fg: theme.muted, wrap: true });
      return;
    }
    const sum = (series: TrafficDay[], k: "count" | "uniques"): number => series.reduce((n, d) => n + d[k], 0);
    const series = (s: TrafficDay[]): number[] => (s.length ? s.map((d) => d.count) : [0]);
    p.sparkline({ values: series(t.views14d), label: "Views 14d", text: `${sum(t.views14d, "count")} / ${sum(t.views14d, "uniques")} unique`, color: theme.info, size: 1 });
    p.sparkline({ values: series(t.clones14d), label: "Clones 14d", text: `${sum(t.clones14d, "count")} / ${sum(t.clones14d, "uniques")} unique`, color: theme.warning, size: 1 });
    p.text(t.referrers.length ? `Referrers: ${t.referrers.slice(0, 4).map((r) => `${r.referrer} ${r.count}`).join(" · ")}` : "No referrers in the report.", { fg: theme.muted, size: 1 });
    p.text(t.paths.length ? `Popular: ${t.paths.slice(0, 3).map((q) => `${q.path.replace(`/${t.repo}`, "") || "/"} ${q.count}`).join(" · ")}` : "No popular paths in the report.", { fg: theme.muted, size: 1 });
    p.text(`${t.url}/graphs/traffic`, { fg: theme.muted, size: 1 });
  });
}

export function pulseView({ ui, theme, width, height, elapsed }: ViewArgs, state: PulseState, root: string, actions: PulseActions = NO_ACTIONS): void {
  const pulse = state.data;
  const label = RANGE_LABEL[state.range];

  ui.row({ size: 1 }, (header) => {
    header.text(" g1tz", { fg: theme.title, bold: true, size: 7 });
    header.text("pulse", { fg: theme.accent, size: 7 });
    header.text(pulse ? pulse.branch || "(detached)" : "", { fg: theme.accent, size: 24 });
    header.text(label, { fg: theme.muted });
    header.text(`${root}  d w m q y a range  p repo  ctrl+c quit `, { fg: theme.muted, align: "right" });
  });

  // One button per range, the current one lit, all clickable. `focused` is
  // pinned off: the library would otherwise paint whichever button holds its
  // focus index (the first) in the strong style, beside the real range.
  ui.buttons(
    RANGE_KEYS.map((k) => ({
      label: k,
      variant: (state.range === k ? "primary" : "ghost") as "primary" | "ghost",
      focused: false,
      onPress: () => actions.pickRange(k),
    })),
    { size: 1 },
  );

  ui.row({ size: height - 3, gap: 1 }, (row) => {
    row.column({ width: "1fr", gap: 1 }, (left) => {
      overviewPanel(left, theme, pulse);
      activityPanel(left, theme, pulse, label, leftPaneColumns(width));
      authorsPanel(left, theme, pulse, label);
    });
    row.column({ width: "1.2fr", gap: 1 }, (right) => {
      filesPanel(right, theme, state, label, rightPaneColumns(width));
      githubPanel(right, theme, state, label, elapsed);
      trafficPanel(right, theme, state.traffic);
    });
  });

  ui.statusBar({
    items: [
      { key: "d w m q y a", label, active: true },
      { key: "↑↓", label: "Files" },
      { key: "r", label: "Refresh", onPress: actions.refresh },
      { key: "p", label: "Repo", onPress: actions.back },
      { key: "ctrl+c", label: "Quit" },
    ],
    right: [{ label: state.note || githubLine(state, elapsed) }],
  });
}
