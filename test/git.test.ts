import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffLineKind, git, parseBranches, parseLog, parseStatus, readRepo, repoRoot, stage, unstage,
} from "../src/git.ts";

/** A throwaway repository, so these tests exercise real git rather than mocks. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "g1tz-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@test"]);
  git(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "first"]);
  return dir;
}

test("porcelain v2 branch headers are parsed", () => {
  const out = [
    "# branch.oid abc",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -3",
    "",
  ].join("\0");
  const s = parseStatus(out);
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 3);
});

test("staged, unstaged and untracked files are told apart", () => {
  const out = [
    "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
    "1 .M N... 100644 100644 100644 aaa bbb dirty.txt",
    "? new.txt",
    "",
  ].join("\0");
  const { files } = parseStatus(out);
  assert.equal(files.length, 3);
  assert.deepEqual(
    files.map((f) => [f.path, f.staged, f.unstaged, f.untracked]),
    [["staged.txt", true, false, false], ["dirty.txt", false, true, false], ["new.txt", false, true, true]],
  );
});

test("a rename carries its original path from the following record", () => {
  const out = [
    "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.txt",
    "old/name.txt",
    "",
  ].join("\0");
  const { files } = parseStatus(out);
  assert.equal(files[0]?.path, "new/name.txt");
  assert.equal(files[0]?.from, "old/name.txt");
});

test("a conflicted file is flagged rather than read as staged", () => {
  const out = ["u UU N... 100644 100644 100644 100644 a b c both.txt", ""].join("\0");
  const { files } = parseStatus(out);
  assert.equal(files[0]?.conflicted, true);
  assert.equal(files[0]?.path, "both.txt");
});

test("a path containing spaces survives parsing", () => {
  const out = ["1 M. N... 100644 100644 100644 aaa bbb some file.txt", ""].join("\0");
  assert.equal(parseStatus(out).files[0]?.path, "some file.txt");
});

test("log records split on the unit separator", () => {
  const line = ["abc123", "abc", "the subject", "Ann", "2 days ago", "HEAD -> main"].join("\x1f");
  const [commit] = parseLog(`${line}\0`);
  assert.equal(commit?.short, "abc");
  assert.equal(commit?.subject, "the subject");
  assert.equal(commit?.author, "Ann");
  assert.equal(commit?.refs, "HEAD -> main");
});

test("branch tracking counts are read from the track field", () => {
  const rows = [
    ["*", "main", "origin/main", "[ahead 2, behind 1]"].join("\x1f"),
    [" ", "topic", "", ""].join("\x1f"),
  ].join("\n");
  const branches = parseBranches(rows);
  assert.equal(branches[0]?.current, true);
  assert.equal(branches[0]?.ahead, 2);
  assert.equal(branches[0]?.behind, 1);
  assert.equal(branches[1]?.current, false);
  assert.equal(branches[1]?.upstream, "");
});

test("diff lines get the colour their prefix implies", () => {
  assert.equal(diffLineKind("+added"), "success");
  assert.equal(diffLineKind("-removed"), "danger");
  assert.equal(diffLineKind("@@ -1 +1 @@"), "accent");
  assert.equal(diffLineKind("+++ b/x"), "muted");
  assert.equal(diffLineKind("--- a/x"), "muted");
  assert.equal(diffLineKind(" context"), "foreground");
});

test("git() returns null instead of throwing when the command fails", () => {
  assert.equal(git("/nope/not/here", ["status"]), null);
  assert.equal(repoRoot("/nope/not/here"), null);
});

// ------------------------------------------------------------ against real git

test("reads a real repository, and staging moves a file between states", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.txt"), "new\n");

    const before = readRepo(dir);
    assert.ok(before, "repository read");
    assert.equal(before.branch, "main");
    assert.equal(before.commits[0]?.subject, "first");

    const dirty = before.files.find((f) => f.path === "a.txt");
    assert.equal(dirty?.unstaged, true, "a.txt is modified but not staged");
    assert.equal(before.files.find((f) => f.path.endsWith("b.txt"))?.untracked, true);

    assert.equal(stage(before.root, dirty!), true);
    const staged = readRepo(dir)!;
    assert.equal(staged.files.find((f) => f.path === "a.txt")?.staged, true);

    assert.equal(unstage(staged.root, staged.files.find((f) => f.path === "a.txt")!), true);
    const back = readRepo(dir)!;
    assert.equal(back.files.find((f) => f.path === "a.txt")?.staged, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean repository reports no files", () => {
  const dir = scratch();
  try {
    assert.deepEqual(readRepo(dir)!.files, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
