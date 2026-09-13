import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../src/git.ts";
import {
  EMPTY_TREE,
  bucketCommits,
  countAuthors,
  foldBuckets,
  parseNumstat,
  parsePulseLog,
  parseRangeKey,
  parseRefDates,
  parseShortstat,
  rangeForHotkey,
  readPulse,
  sinceFor,
  unitFor,
  type PulseCommit,
} from "../src/pulse.ts";

const NOW = new Date("2026-09-13T12:00:00Z");

/** A throwaway repository, so these tests exercise real git rather than mocks. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "g1tz-pulse-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@test"]);
  git(dir, ["config", "user.name", "T"]);
  return dir;
}

/** Commit whatever is staged at a fixed date, by a named author. */
function commit(dir: string, message: string, at: string, author = "T <t@test>"): void {
  const r = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", message, `--author=${author}`], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_PAGER: "cat" },
  });
  assert.equal(r.status, 0, r.stderr);
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, ["add", "--", path]);
}

/** Six weeks of history: an old commit, two on main this week, one on a topic branch, a rename across the period and a tag. */
function history(): string {
  const dir = scratch();
  write(dir, "old.txt", "old\n");
  write(dir, "b.txt", "b\n");
  commit(dir, "long ago", "2026-08-01T10:00:00Z");
  write(dir, "a.txt", "one\n");
  commit(dir, "a", "2026-09-10T10:00:00Z");
  git(dir, ["checkout", "-q", "-b", "topic"]);
  write(dir, "t.txt", "topic\n");
  commit(dir, "on topic", "2026-09-11T10:00:00Z", "Bo <bo@test>");
  git(dir, ["checkout", "-q", "main"]);
  write(dir, "a.txt", "one\ntwo\nthree\n");
  git(dir, ["mv", "b.txt", "c.txt"]);
  commit(dir, "edit a, rename b", "2026-09-12T10:00:00Z");
  // A lightweight tag takes the commit's date, so it lands inside the week.
  git(dir, ["tag", "v1"]);
  return dir;
}

const c = (at: string, author = "T", merge = false): PulseCommit =>
  ({ hash: "h", short: "h", author, email: "", at, subject: "", merge });

test("range keys read every spelling people type", () => {
  assert.equal(parseRangeKey("week"), "week");
  assert.equal(parseRangeKey("7d"), "week");
  assert.equal(parseRangeKey(" ALL "), "all");
  assert.equal(parseRangeKey("24h"), "day");
  assert.equal(parseRangeKey("fortnight"), null);
  assert.equal(rangeForHotkey("m"), "month");
  assert.equal(rangeForHotkey("x"), null);
});

test("a range starts a fixed time ago, and all time has no start", () => {
  assert.equal(sinceFor("day", NOW)?.toISOString(), "2026-09-12T12:00:00.000Z");
  assert.equal(sinceFor("all", NOW), null);
  assert.equal(unitFor("day"), "hour");
  assert.equal(unitFor("year"), "week");
  assert.equal(unitFor("all"), "month");
});

test("the log parser reads NUL records and tells a merge by its parents", () => {
  const out = [
    ["a".repeat(40), "aaaaaaa", "Ann", "ann@x", "2026-09-12T10:00:00+00:00", "p1", "one"].join("\x1f"),
    `\n${["b".repeat(40), "bbbbbbb", "Bo", "bo@x", "2026-09-11T10:00:00+00:00", "p1 p2", "merge"].join("\x1f")}`,
    "",
  ].join("\0");
  const commits = parsePulseLog(out);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]?.author, "Ann");
  assert.equal(commits[0]?.merge, false);
  assert.equal(commits[1]?.hash, "b".repeat(40), "the newline between records is not part of the hash");
  assert.equal(commits[1]?.merge, true);
});

test("numstat -z handles a rename, a binary file and a path with a newline", () => {
  const out = ["3\t1\tsrc/a.ts", "0\t0\t", "old/name.txt", "new/name.txt", "-\t-\timg.png", "1\t0\tweird\nname.txt", ""].join("\0");
  const files = parseNumstat(out);
  assert.deepEqual(files, [
    { path: "src/a.ts", added: 3, deleted: 1, binary: false },
    { path: "new/name.txt", from: "old/name.txt", added: 0, deleted: 0, binary: false },
    { path: "img.png", added: 0, deleted: 0, binary: true },
    { path: "weird\nname.txt", added: 1, deleted: 0, binary: false },
  ]);
});

test("shortstat is read whether or not each part is present", () => {
  assert.deepEqual(parseShortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n"), { filesChanged: 3, additions: 12, deletions: 4 });
  assert.deepEqual(parseShortstat(" 1 file changed, 1 deletion(-)"), { filesChanged: 1, additions: 0, deletions: 1 });
  assert.deepEqual(parseShortstat(""), { filesChanged: 0, additions: 0, deletions: 0 });
});

test("ref dates are read one per line", () => {
  const refs = parseRefDates("main\x1f2026-09-12T10:00:00+00:00\ntopic\x1f2026-09-11T10:00:00+00:00\n\n");
  assert.deepEqual(refs.map((r) => r.name), ["main", "topic"]);
  assert.equal(refs[1]?.at, "2026-09-11T10:00:00+00:00");
});

test("authors exclude merges and are ranked busiest first", () => {
  const authors = countAuthors([c("2026-09-12T10:00:00Z", "Bo"), c("2026-09-11T10:00:00Z", "Ann"), c("2026-09-10T10:00:00Z", "Bo"), c("2026-09-09T10:00:00Z", "Cy", true)]);
  assert.deepEqual(authors, [{ name: "Bo", commits: 2 }, { name: "Ann", commits: 1 }]);
});

test("buckets are contiguous from the start of the period and count the commits into the right day", () => {
  const since = sinceFor("week", NOW);
  const buckets = bucketCommits([c("2026-09-12T10:00:00Z"), c("2026-09-12T18:00:00Z"), c("2026-09-10T10:00:00Z")], since, NOW, "day");
  assert.equal(buckets.length, 8, "the seven days plus today");
  assert.equal(buckets[0]?.label, "09-06");
  assert.deepEqual(buckets.map((b) => b.count), [0, 0, 0, 0, 1, 0, 2, 0]);
});

test("hour buckets cover a day, week buckets start on Monday, and all time starts at the first commit", () => {
  assert.equal(bucketCommits([], sinceFor("day", NOW), NOW, "hour").length, 25);
  const weeks = bucketCommits([c("2026-09-12T10:00:00Z")], new Date("2026-09-10T00:00:00Z"), NOW, "week");
  assert.equal(weeks[0]?.start, "2026-09-07T00:00:00.000Z", "2026-09-07 is a Monday");
  const months = bucketCommits([c("2026-07-20T10:00:00Z"), c("2026-09-01T00:00:00Z")], null, NOW, "month");
  assert.deepEqual(months.map((b) => [b.label, b.count]), [["2026-07", 1], ["2026-08", 0], ["2026-09", 1]]);
  assert.equal(bucketCommits([], null, NOW, "month").length, 1, "no commits at all still draws the current month");
});

test("folding keeps the totals and the first label of each group", () => {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ label: `b${i}`, start: "", count: i }));
  const folded = foldBuckets(buckets, 4);
  assert.deepEqual(folded.map((b) => [b.label, b.count]), [["b0", 3], ["b3", 12], ["b6", 21], ["b9", 9]]);
  assert.equal(foldBuckets(buckets, 20).length, 10);
});

test("the week: commits on the branch, on every branch, the authors, and the tree since the period began", () => {
  const dir = history();
  const p = readPulse(dir, "week", NOW);
  assert.equal(p.branch, "main");
  assert.equal(p.since, "2026-09-06T12:00:00.000Z");
  assert.deepEqual(p.commits.map((x) => x.subject), ["edit a, rename b", "a"]);
  assert.equal(p.allBranchCommits, 3, "topic's commit counts on all branches");
  assert.deepEqual(p.authors, [{ name: "T", commits: 2 }]);
  assert.equal(p.filesChanged, 2, "a.txt and the rename; the old file is untouched");
  assert.equal(p.additions, 3);
  assert.deepEqual(p.files.map((f) => [f.path, f.from, f.added]), [["a.txt", undefined, 3], ["c.txt", "b.txt", 0]], "b.txt existed before the period, so its move is a rename");
  assert.deepEqual(p.branches.map((b) => b.name), ["main", "topic"]);
  assert.deepEqual(p.tags.map((t) => t.name), ["v1"]);
  assert.equal(p.unit, "day");
  assert.equal(p.buckets.reduce((t, b) => t + b.count, 0), 2);
  assert.deepEqual(p.errors, []);
});

test("all time diffs from the empty tree and starts the buckets at the first commit", () => {
  const dir = history();
  const p = readPulse(dir, "all", NOW);
  assert.equal(p.since, null);
  assert.equal(p.commits.length, 3);
  assert.equal(p.filesChanged, 3, "old.txt, a.txt and c.txt");
  assert.equal(p.unit, "month");
  assert.deepEqual(p.buckets.map((b) => [b.label, b.count]), [["2026-08", 1], ["2026-09", 2]]);
  assert.equal(EMPTY_TREE, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("a merge is counted as one, its authors are kept, and the boundary follows the first parent", () => {
  const dir = history();
  const r = spawnSync("git", ["merge", "-q", "--no-ff", "-m", "merge topic", "topic"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-12T12:00:00Z", GIT_COMMITTER_DATE: "2026-09-12T12:00:00Z", GIT_EDITOR: "true" },
  });
  assert.equal(r.status, 0, r.stderr);
  const p = readPulse(dir, "week", NOW);
  assert.equal(p.commits.length, 4);
  assert.equal(p.commits.filter((x) => x.merge).length, 1);
  assert.deepEqual(p.authors, [{ name: "T", commits: 2 }, { name: "Bo", commits: 1 }]);
  assert.equal(p.filesChanged, 3, "the topic's file arrived through the merge");
});

test("a root commit inside the period diffs from the empty tree", () => {
  const dir = scratch();
  write(dir, "only.txt", "hi\n");
  commit(dir, "first", "2026-09-12T10:00:00Z");
  const p = readPulse(dir, "week", NOW);
  assert.equal(p.filesChanged, 1);
  assert.equal(p.additions, 1);
});

test("an empty repository has an empty pulse and no errors", () => {
  const p = readPulse(scratch(), "week", NOW);
  assert.equal(p.commits.length, 0);
  assert.equal(p.filesChanged, 0);
  assert.equal(p.allBranchCommits, 0);
  assert.deepEqual(p.errors, []);
  assert.equal(p.buckets.length, 8);
});

test("a detached head has no branch name", () => {
  const dir = history();
  git(dir, ["checkout", "-q", "--detach"]);
  assert.equal(readPulse(dir, "week", NOW).branch, "");
});
