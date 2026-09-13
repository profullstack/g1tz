import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToText } from "@profullstack/hqtui/testing";
import type { Repo } from "../src/git.ts";
import type { Fetch } from "../src/github.ts";
import { USAGE, createState, openPulse, parseCli, scrollPulseFiles, startGitHub, view, type State } from "../src/main.ts";

const NOW = new Date("2026-09-13T12:00:00Z");

function repo(): Repo {
  return {
    root: "/tmp/demo",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    commits: [{ hash: "a".repeat(40), short: "aaaaaaa", subject: "one", author: "Ann", when: "2 hours ago", refs: "" }],
    branches: [{ name: "main", current: true, upstream: "origin/main", ahead: 0, behind: 0 }],
    errors: [],
  };
}

function state(): State {
  const s = createState(repo());
  s.diff = [];
  return s;
}

/** A GitHub with nothing in it. */
const quiet: Fetch = async (path) => (path === "repos/o/r" ? { stargazers_count: 0 } : []);

test("the command line: a path, the pulse verb, a range", () => {
  assert.deepEqual(parseCli([]), { path: ".", pulse: false, help: false });
  assert.deepEqual(parseCli(["~/x"]), { path: "~/x", pulse: false, help: false });
  assert.deepEqual(parseCli(["pulse", "~/x", "--range", "month"]), { path: "~/x", pulse: true, help: false, range: "month" });
  assert.equal(parseCli(["--range=7d"]).range, "week");
  assert.equal(parseCli(["--range=7d"]).pulse, true, "a range implies the pulse screen");
  assert.match(parseCli(["--range", "fortnight"]).error ?? "", /--range wants one of/);
  assert.match(parseCli(["--bogus"]).error ?? "", /unknown option/);
  assert.equal(parseCli(["-h"]).help, true);
  assert.match(USAGE, /g1tz pulse/);
});

test("the repository screen offers pulse, and the pulse screen replaces it", () => {
  const s = state();
  const before = renderToText((args) => view(args as never, s), { width: 110, height: 30 });
  assert.match(before, /p Pulse/, "the status bar offers it");
  assert.match(before, /Files \(0\)/);
  openPulse(s, "month", NOW);
  assert.equal(s.screen, "pulse");
  assert.equal(s.pulse.range, "month");
  assert.equal(s.pulse.data?.range, "month", "opening reads the pulse for the range");
  const after = renderToText((args) => view(args as never, s), { width: 110, height: 30 });
  assert.match(after, /pulse/);
  assert.match(after, /Overview/);
  assert.doesNotMatch(after, /Files \(0\)/);
});

test("files scroll inside the list", () => {
  const s = state();
  openPulse(s, "week", NOW);
  s.pulse.data!.files = [
    { path: "a", added: 1, deleted: 0, binary: false },
    { path: "b", added: 1, deleted: 0, binary: false },
    { path: "c", added: 1, deleted: 0, binary: false },
  ];
  scrollPulseFiles(s, 10);
  assert.equal(s.pulse.filesOffset, 2);
  scrollPulseFiles(s, -10);
  assert.equal(s.pulse.filesOffset, 0);
});

test("GitHub is skipped without a GitHub remote or without gh, and read otherwise", async () => {
  const s = state();
  let changes = 0;
  await startGitHub(s, () => { changes++; }, NOW, quiet, () => true);
  assert.equal(s.pulse.githubStatus, "unavailable");
  assert.match(s.pulse.githubNote, /not a GitHub remote/);
  s.github = { owner: "o", name: "r" };
  await startGitHub(s, () => { changes++; }, NOW, quiet, () => false);
  assert.match(s.pulse.githubNote, /gh is not installed/);
  await startGitHub(s, () => { changes++; }, NOW, quiet, () => true);
  assert.equal(s.pulse.githubStatus, "ready");
  assert.equal(s.pulse.github?.repo, "o/r");
  assert.ok(changes >= 4, "the screen is told about every change");
});

test("a GitHub failure is a note, not a crash", async () => {
  const s = state();
  s.github = { owner: "o", name: "r" };
  await startGitHub(s, () => {}, NOW, async () => { throw new Error("gh is not logged in (run gh auth login)"); }, () => true);
  assert.equal(s.pulse.githubStatus, "unavailable");
  assert.match(s.pulse.githubNote, /not logged in/);
});

test("a reply to an older request is dropped once a newer one has answered", async () => {
  const s = state();
  s.github = { owner: "o", name: "r" };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: Fetch = async (path) => {
    if (path !== "repos/o/r") return [];
    await gate;
    return { stargazers_count: 1 };
  };
  const first = startGitHub(s, () => {}, NOW, slow, () => true);
  const second = startGitHub(s, () => {}, NOW, quiet, () => true);
  await second;
  assert.equal(s.pulse.github?.stars, 0, "the newer answer is in");
  release();
  await first;
  assert.equal(s.pulse.github?.stars, 0, "the older answer is dropped");
  assert.equal(s.pulse.githubStatus, "ready");
});
