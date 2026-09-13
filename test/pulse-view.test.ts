import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToScreen, renderToText } from "@profullstack/hqtui/testing";
import type { GitHubPulse } from "../src/github.ts";
import type { Pulse } from "../src/pulse.ts";
import { clampOffset, createPulseState, githubLine, pulseView, shortenPath, type PulseActions, type PulseState } from "../src/pulse-view.ts";
import type { Traffic } from "../src/traffic.ts";

function pulse(over: Partial<Pulse> = {}): Pulse {
  return {
    range: "week",
    since: "2026-09-06T12:00:00.000Z",
    until: "2026-09-13T12:00:00.000Z",
    branch: "main",
    commits: [
      { hash: "a".repeat(40), short: "aaaaaaa", author: "Ann", email: "", at: "2026-09-12T10:00:00Z", subject: "one", merge: false },
      { hash: "b".repeat(40), short: "bbbbbbb", author: "Bo", email: "", at: "2026-09-11T10:00:00Z", subject: "two", merge: false },
      { hash: "c".repeat(40), short: "ccccccc", author: "Ann", email: "", at: "2026-09-10T10:00:00Z", subject: "merge", merge: true },
    ],
    commitsTruncated: false,
    allBranchCommits: 5,
    authors: [{ name: "Ann", commits: 1 }, { name: "Bo", commits: 1 }],
    filesChanged: 2,
    additions: 30,
    deletions: 4,
    files: [
      { path: "src/a.ts", added: 25, deleted: 4, binary: false },
      { path: "docs/new.md", from: "docs/old.md", added: 5, deleted: 0, binary: false },
    ],
    unit: "day",
    buckets: ["09-06", "09-07", "09-08", "09-09", "09-10", "09-11", "09-12", "09-13"].map((label, i) => ({ label, start: "", count: [0, 0, 0, 0, 1, 1, 1, 0][i] as number })),
    branches: [{ name: "main", at: "2026-09-12T10:00:00Z" }],
    tags: [{ name: "v0.2.0", at: "2026-09-12T10:00:00Z" }],
    errors: [],
    ...over,
  };
}

const GITHUB: GitHubPulse = {
  repo: "profullstack/g1tz",
  url: "https://github.com/profullstack/g1tz",
  description: "",
  stars: 12,
  forks: 2,
  openIssues: 3,
  prsOpened: [{ number: 7, title: "pulse screen", user: "ann", at: "2026-09-12T10:00:00Z" }],
  prsMerged: [{ number: 6, title: "word diffs", user: "bo", at: "2026-09-11T10:00:00Z" }],
  prsClosed: [],
  issuesOpened: [{ number: 5, title: "hunk staging", user: "cy", at: "2026-09-10T10:00:00Z" }],
  issuesClosed: [],
  releases: [{ tag: "v0.2.0", name: "v0.2.0", at: "2026-09-12T10:00:00Z" }],
  newStars: 4,
  partial: false,
};

const TRAFFIC: Traffic = {
  repo: "profullstack/g1tz",
  url: "https://github.com/profullstack/g1tz",
  reportAt: "2026-09-13T03:05:36.694Z",
  stars: 12,
  forks: 2,
  views14d: [{ day: "2026-09-10", count: 4, uniques: 2 }, { day: "2026-09-11", count: 9, uniques: 3 }],
  clones14d: [{ day: "2026-09-10", count: 3, uniques: 3 }],
  referrers: [{ referrer: "hqtui.com", count: 2, uniques: 1 }],
  paths: [{ path: "/profullstack/g1tz", count: 4, uniques: 2 }],
};

function state(over: Partial<PulseState> = {}): PulseState {
  return { ...createPulseState(), data: pulse(), ...over };
}

const frame = (s: PulseState, width = 132, height = 34, actions?: PulseActions): string =>
  renderToText((args) => pulseView(args as never, s, "~/g1tz", actions), { width, height });

test("every panel draws with the repository's numbers", () => {
  const out = frame(state());
  assert.match(out, /pulse/);
  assert.match(out, /last week/);
  assert.match(out, /Overview/);
  assert.match(out, /2 on main, 1 merge/);
  assert.match(out, /5 commits, merges excluded/);
  assert.match(out, /2 files, \+30 −4/);
  assert.match(out, /1 new: v0\.2\.0/);
  assert.match(out, /Commits per day/);
  assert.match(out, /peak 1 in one day/);
  assert.match(out, /Authors \(2\)/);
  assert.match(out, /Ann/);
  assert.match(out, /50%/);
  assert.match(out, /Files changed \(2\)/);
  assert.match(out, /src\/a\.ts/);
  assert.match(out, /\+25/);
  assert.match(out, /docs\/old\.md → docs\/new\.md/);
  assert.match(out, /ctrl\+c Quit/, "q is a range here, so the status bar names the real quit key");
});

test("the range buttons are drawn and clicking one picks that range", () => {
  const picked: string[] = [];
  const actions: PulseActions = { pickRange: (k) => picked.push(k), refresh: () => {}, back: () => {}, pulse: () => {} };
  const screen = renderToScreen((args) => pulseView(args as never, state(), "~/g1tz", actions), { width: 132, height: 34 });
  for (const k of ["day", "week", "month", "quarter", "year", "all"]) assert.ok(screen.contains(k), `${k} button`);
  const at = screen.find("month");
  assert.ok(at, "the month button is on screen");
  assert.equal(screen.click(at.x, at.y), true, "the button is a click target");
  assert.deepEqual(picked, ["month"]);
});

test("a quiet period says so in every pane", () => {
  const out = frame(state({ data: pulse({ commits: [], authors: [], files: [], filesChanged: 0, additions: 0, deletions: 0, buckets: [{ label: "09-06", start: "", count: 0 }], branches: [], tags: [] }) }));
  assert.match(out, /0 on main/);
  assert.match(out, /No commits, last week\./);
  assert.match(out, /Nothing changed, last week\./);
  assert.match(out, /none active/);
});

test("GitHub is asked, absent, or answered", () => {
  assert.match(frame(state({ githubStatus: "loading" })), /asking GitHub/);
  const off = frame(state({ githubStatus: "unavailable", githubNote: "gh is not logged in (run gh auth login)" }));
  assert.match(off, /gh is not logged in/);
  const on = frame(state({ githubStatus: "ready", github: GITHUB }));
  assert.match(on, /GitHub  profullstack\/g1tz/);
  assert.match(on, /1 merged, 1 opened, 0 closed unmerged/);
  assert.match(on, /1 opened, 0 closed, 3 open now/);
  assert.match(on, /1: v0\.2\.0/);
  assert.match(on, /\+4, 12 total, 2 forks/);
  assert.match(on, /merged #6 word diffs \(bo\)/);
  assert.match(frame(state({ githubStatus: "idle" })), /appear here when gh is/, "the sentence wraps, so only its head is asserted");
});

test("the status bar names the GitHub state", () => {
  assert.equal(githubLine(state({ githubStatus: "unavailable", githubNote: "gh is not installed" }), 0), "GitHub: gh is not installed");
  assert.equal(githubLine(state({ githubStatus: "ready", github: { ...GITHUB, partial: true } }), 0), "GitHub counts are floors (page budget)");
  assert.equal(githubLine(state({ githubStatus: "ready", github: GITHUB }), 0), "");
  assert.match(githubLine(state({ githubStatus: "loading" }), 0), /GitHub$/);
});

test("traffic comes from the gh-pulse report, or says where it would come from", () => {
  const with_ = frame(state({ traffic: TRAFFIC }));
  assert.match(with_, /Traffic  gh-pulse 2026-09-13 03:05/);
  assert.match(with_, /Views 14d/);
  assert.match(with_, /13 \/ 5 unique/);
  assert.match(with_, /Clones 14d/);
  assert.match(with_, /Referrers: hqtui\.com 2/);
  assert.match(with_, /graphs\/traffic/);
  assert.match(frame(state()), /gh-pulse report exists/);
});

test("paths keep their tail and offsets stay inside the list", () => {
  assert.equal(shortenPath("src/really/deep/path/file.ts", 12), "…ath/file.ts");
  assert.equal(shortenPath("short.ts", 12), "short.ts");
  assert.equal(clampOffset(-3, 10), 0);
  assert.equal(clampOffset(50, 10), 9);
  assert.equal(clampOffset(2, 0), 0);
});

test("the layout survives a narrow terminal", () => {
  const out = frame(state({ githubStatus: "ready", github: GITHUB, traffic: TRAFFIC }), 60, 24);
  assert.ok(out.split("\n").every((l) => l.length <= 60), "no row overflows the width");
});

test("a pulse that has not been read yet asks for one", () => {
  assert.match(frame(state({ data: null })), /Press r to read the repository/);
});
