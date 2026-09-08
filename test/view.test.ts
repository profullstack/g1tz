import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToText } from "@profullstack/hqtui/testing";
import { createState, view, move, type State } from "../src/main.ts";
import type { Repo } from "../src/git.ts";

function repo(over: Partial<Repo> = {}): Repo {
  return {
    root: "/tmp/demo",
    branch: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    files: [
      { index: "M", work: ".", path: "src/a.ts", staged: true, unstaged: false, untracked: false, conflicted: false },
      { index: ".", work: "M", path: "src/b.ts", staged: false, unstaged: true, untracked: false, conflicted: false },
      { index: "?", work: "?", path: "new.ts", staged: false, unstaged: true, untracked: true, conflicted: false },
    ],
    commits: [
      { hash: "a".repeat(40), short: "aaaaaaa", subject: "make it work", author: "Ann", when: "2 hours ago", refs: "HEAD -> main" },
      { hash: "b".repeat(40), short: "bbbbbbb", subject: "make it right", author: "Bo", when: "1 day ago", refs: "" },
    ],
    branches: [
      { name: "main", current: true, upstream: "origin/main", ahead: 2, behind: 1 },
      { name: "topic", current: false, upstream: "", ahead: 0, behind: 0 },
    ],
    errors: [],
    ...over,
  };
}

function state(over: Partial<Repo> = {}): State {
  const s = createState(repo(over));
  // createState reads a real diff from disk; this repo is a fixture.
  s.diff = [];
  return s;
}

const frame = (s: State, width = 110, height = 30): string =>
  renderToText((args) => view(args as never, s), { width, height });

test("all four panes draw", () => {
  const out = frame(state());
  assert.match(out, /Files \(3\)/);
  assert.match(out, /Branches \(2\)/);
  assert.match(out, /Log \(2\)/);
  assert.match(out, /Diff/);
});

test("the header shows branch and tracking", () => {
  const out = frame(state());
  assert.match(out, /main/);
  assert.match(out, /origin\/main/);
  assert.match(out, /↑2/);
  assert.match(out, /↓1/);
});

test("file status glyphs distinguish staged, unstaged and untracked", () => {
  const out = frame(state());
  assert.match(out, /M\s+src\/a\.ts/);
  assert.match(out, /M\s+src\/b\.ts/);
  assert.match(out, /\?\?\s+new\.ts/);
});

test("the current branch is marked", () => {
  assert.match(frame(state()), /\* main/);
});

test("commits show short hash, subject and age", () => {
  const out = frame(state());
  assert.match(out, /aaaaaaa/);
  assert.match(out, /make it work/);
  assert.match(out, /2 hours ago/);
});

test("a clean tree says so instead of drawing an empty pane", () => {
  assert.match(frame(state({ files: [] })), /Working tree clean/);
});

test("an empty repository does not crash the log pane", () => {
  const out = frame(state({ commits: [], branches: [], files: [] }));
  assert.match(out, /No commits/);
  assert.match(out, /No branches/);
});

test("diff lines render with their content", () => {
  const s = state();
  s.diff = ["@@ -1,2 +1,3 @@", " context", "-gone", "+added"];
  const out = frame(s);
  assert.match(out, /@@ -1,2 \+1,3 @@/);
  assert.match(out, /\+added/);
  assert.match(out, /-gone/);
});

test("moving the selection stays inside the list", () => {
  const s = state();
  move(s, -5);
  assert.equal(s.selected.files, 0);
  move(s, 99);
  assert.equal(s.selected.files, 2, "clamped to the last file");
});

test("the layout survives a narrow terminal", () => {
  const out = frame(state(), 60, 24);
  assert.ok(out.split("\n").every((l) => l.length <= 60), "no row overflows the width");
});

test("a detached head renders rather than showing an empty branch", () => {
  assert.match(frame(state({ branch: "", upstream: "" })), /\(detached\)/);
});
