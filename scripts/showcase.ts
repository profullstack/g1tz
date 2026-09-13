/**
 * Frames for the hqtui.com apps showcase.
 *
 * A fixture repository rather than whatever happens to be checked out, so the
 * screenshot is the same on every machine and every run.
 */
import { createState, view } from "../src/main.ts";
import type { Repo } from "../src/git.ts";
import type { GitHubPulse } from "../src/github.ts";
import type { Pulse } from "../src/pulse.ts";
import type { Traffic } from "../src/traffic.ts";

const REPO: Repo = {
  root: "~/hqtui",
  branch: "spans-richtext",
  upstream: "origin/spans-richtext",
  ahead: 2,
  behind: 0,
  files: [
    { index: "M", work: ".", path: "packages/hqtui/src/richtext.ts", staged: true, unstaged: false, untracked: false, conflicted: false },
    { index: "M", work: ".", path: "packages/hqtui/src/surface.ts", staged: true, unstaged: false, untracked: false, conflicted: false },
    { index: ".", work: "M", path: "packages/hqtui/src/widgets/text.ts", staged: false, unstaged: true, untracked: false, conflicted: false },
    { index: "?", work: "?", path: "packages/hqtui/test/richtext.test.ts", staged: false, unstaged: true, untracked: true, conflicted: false },
  ],
  commits: [
    { hash: "a".repeat(40), short: "43d0e3e", subject: "feat(text): styled spans", author: "Ann", when: "12 minutes ago", refs: "HEAD -> spans" },
    { hash: "b".repeat(40), short: "714b354", subject: "fix(demo): make [c] actually collapse", author: "Ann", when: "2 hours ago", refs: "" },
    { hash: "c".repeat(40), short: "e28fec7", subject: "Finish widget parity", author: "Bo", when: "yesterday", refs: "" },
    { hash: "d".repeat(40), short: "2343621", subject: "feat: COBOL is a demo language", author: "Bo", when: "yesterday", refs: "" },
  ],
  branches: [
    { name: "spans-richtext", current: true, upstream: "origin/spans-richtext", ahead: 2, behind: 0 },
    { name: "main", current: false, upstream: "origin/main", ahead: 0, behind: 1 },
    { name: "release-0-3-0", current: false, upstream: "", ahead: 0, behind: 0 },
  ],
  errors: [],
};

const DIFF = [
  "diff --git a/packages/hqtui/src/widgets/text.ts b/packages/hqtui/src/widgets/text.ts",
  "index 4a1c8e2..9f3b7d1 100644",
  "--- a/packages/hqtui/src/widgets/text.ts",
  "+++ b/packages/hqtui/src/widgets/text.ts",
  "@@ -24,9 +24,14 @@ function attrsOf(o: TextOptions): number {",
  " ",
  "-export function drawText(surface: Surface, content: string, options: TextOptions = {}): void {",
  "+export function drawText(surface: Surface, content: RichText, options: TextOptions = {}): void {",
  "   if (surface.empty) return;",
  "   const style: Style = {",
  "     fg: options.fg ?? surface.theme.foreground,",
  "   };",
  "-  const lines = content.split(\"\\n\");",
  "+  const lines = options.wrap ? wrapRich(content, surface.width) : toSpanLines(content);",
  "   for (let i = 0; i < lines.length && i < surface.height; i++) {",
  "-    surface.text(0, i, lines[i], style);",
  "+    surface.spans(0, i, fitSpans(lines[i], surface.width, options.align ?? \"left\"), style);",
  "   }",
  " }",
];

/** A week of the same repository, for the Pulse frame. */
const c = (short: string, author: string, at: string, subject: string, merge = false) =>
  ({ hash: short.repeat(6).slice(0, 40), short, author, email: "", at, subject, merge });

const PULSE: Pulse = {
  range: "week",
  since: "2026-09-06T12:00:00.000Z",
  until: "2026-09-13T12:00:00.000Z",
  branch: "spans-richtext",
  commits: [
    c("43d0e3e", "Ann", "2026-09-13T09:48:00Z", "feat(text): styled spans"),
    c("714b354", "Ann", "2026-09-13T07:10:00Z", "fix(demo): make [c] actually collapse"),
    c("e28fec7", "Bo", "2026-09-12T18:02:00Z", "Finish widget parity"),
    c("2343621", "Bo", "2026-09-12T15:31:00Z", "feat: COBOL is a demo language"),
    c("9b1c0aa", "Ann", "2026-09-11T20:14:00Z", "Merge pull request #58 from ports/zig-016", true),
    c("5f77d21", "Cy", "2026-09-11T19:05:00Z", "zig: std.process.Init replaces getenv"),
    c("0ac41e9", "Cy", "2026-09-11T11:40:00Z", "zig: drop posix.write"),
    c("d81b2f0", "Ann", "2026-09-10T22:55:00Z", "Graph: the y-axis minimum belongs to the plot"),
    c("77e0c1b", "Bo", "2026-09-09T16:20:00Z", "Recapture the gallery"),
    c("31a9f4d", "Ann", "2026-09-08T10:05:00Z", "/apps: nine applications, not three"),
  ],
  commitsTruncated: false,
  allBranchCommits: 14,
  authors: [{ name: "Ann", commits: 4 }, { name: "Bo", commits: 3 }, { name: "Cy", commits: 2 }],
  filesChanged: 27,
  additions: 1843,
  deletions: 412,
  files: [
    { path: "packages/hqtui/src/richtext.ts", added: 412, deleted: 0, binary: false },
    { path: "packages/hqtui/src/widgets/text.ts", added: 188, deleted: 96, binary: false },
    { path: "ports/zig/src/terminal.zig", added: 141, deleted: 120, binary: false },
    { path: "packages/hqtui/test/richtext.test.ts", added: 236, deleted: 0, binary: false },
    { path: "apps/web/app/apps/page.tsx", added: 174, deleted: 31, binary: false },
    { path: "packages/hqtui/src/surface.ts", added: 97, deleted: 44, binary: false },
    { path: "packages/hqtui/src/graphics/chart.ts", added: 58, deleted: 39, binary: false },
    { path: "apps/web/public/apps/g1tz.png", added: 0, deleted: 0, binary: true },
    { path: "ports/zig/src/main.zig", added: 33, deleted: 41, binary: false },
    { path: "docs/PRD.md", from: "docs/VTTUI.md", added: 62, deleted: 8, binary: false },
    { path: "packages/hqtui/src/index.ts", added: 12, deleted: 2, binary: false },
    { path: "apps/demo/scripts/shots.ts", added: 9, deleted: 9, binary: false },
  ],
  unit: "day",
  buckets: [
    { label: "09-06", start: "2026-09-06T00:00:00.000Z", count: 0 },
    { label: "09-07", start: "2026-09-07T00:00:00.000Z", count: 0 },
    { label: "09-08", start: "2026-09-08T00:00:00.000Z", count: 1 },
    { label: "09-09", start: "2026-09-09T00:00:00.000Z", count: 1 },
    { label: "09-10", start: "2026-09-10T00:00:00.000Z", count: 1 },
    { label: "09-11", start: "2026-09-11T00:00:00.000Z", count: 3 },
    { label: "09-12", start: "2026-09-12T00:00:00.000Z", count: 2 },
    { label: "09-13", start: "2026-09-13T00:00:00.000Z", count: 2 },
  ],
  branches: [
    { name: "spans-richtext", at: "2026-09-13T09:48:00Z" },
    { name: "main", at: "2026-09-11T20:14:00Z" },
    { name: "ports/zig-016", at: "2026-09-11T19:05:00Z" },
  ],
  tags: [{ name: "v0.6.0", at: "2026-09-12T18:30:00Z" }],
  errors: [],
};

const GITHUB: GitHubPulse = {
  repo: "profullstack/hqtui",
  url: "https://github.com/profullstack/hqtui",
  description: "High Quality Terminal UI",
  stars: 218,
  forks: 14,
  openIssues: 9,
  prsOpened: [{ number: 61, title: "Styled spans in text and table cells", user: "ann", at: "2026-09-13T08:00:00Z" }],
  prsMerged: [
    { number: 58, title: "Zig 0.16: std.process.Init, no posix.write", user: "cy", at: "2026-09-11T20:14:00Z" },
    { number: 57, title: "Graph: y-axis minimum belongs to the plot", user: "ann", at: "2026-09-10T23:00:00Z" },
  ],
  prsClosed: [],
  issuesOpened: [{ number: 60, title: "Styled spans within a line", user: "g1tz", at: "2026-09-12T10:00:00Z" }],
  issuesClosed: [{ number: 55, title: "Braille glyphs render wide in Chrome", user: "bo", at: "2026-09-09T16:30:00Z" }],
  releases: [{ tag: "v0.6.0", name: "v0.6.0", at: "2026-09-12T18:30:00Z" }],
  newStars: 62,
  partial: false,
};

const TRAFFIC: Traffic = {
  repo: "profullstack/hqtui",
  url: "https://github.com/profullstack/hqtui",
  reportAt: "2026-09-13T03:05:00.000Z",
  stars: 218,
  forks: 14,
  views14d: [14, 22, 31, 18, 40, 77, 128, 96, 54, 61, 143, 210, 172, 88].map((count, i) => ({ day: `2026-08-${28 + i}`, count, uniques: Math.round(count / 3) })),
  clones14d: [3, 5, 4, 6, 9, 12, 21, 17, 10, 8, 26, 33, 29, 15].map((count, i) => ({ day: `2026-08-${28 + i}`, count, uniques: Math.round(count / 2) })),
  referrers: [{ referrer: "news.ycombinator.com", count: 412, uniques: 388 }, { referrer: "hqtui.com", count: 96, uniques: 51 }, { referrer: "bsky.app", count: 44, uniques: 39 }],
  paths: [{ path: "/profullstack/hqtui", count: 611, uniques: 402 }, { path: "/profullstack/hqtui/tree/main/ports", count: 88, uniques: 60 }],
};

export const frames = [
  {
    name: "g1tz",
    width: 132,
    height: 34,
    draw: (args: { ui: unknown; theme: unknown; height: number }) => {
      const state = createState(REPO);
      state.diff = DIFF;
      state.selected.files = 2;
      view(args as never, state);
    },
  },
  {
    name: "g1tz-pulse",
    width: 132,
    height: 34,
    draw: (args: { ui: unknown; theme: unknown; height: number }) => {
      const state = createState(REPO);
      state.screen = "pulse";
      state.pulse.data = PULSE;
      state.pulse.github = GITHUB;
      state.pulse.githubStatus = "ready";
      state.pulse.traffic = TRAFFIC;
      view(args as never, state);
    },
  },
];
