/**
 * Everything g1tz knows about a repository, read by shelling out to git.
 *
 * Porcelain formats only, with explicit -z where a filename could contain a
 * newline. Parsing `git status` output meant for humans is how a TUI ends up
 * corrupting someone's working tree.
 */
import { spawnSync } from "node:child_process";

export interface FileChange {
  /** Index status, as git reports it: M, A, D, R, C, U or space. */
  index: string;
  /** Worktree status. */
  work: string;
  path: string;
  /** Original path for a rename. */
  from?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  when: string;
  refs: string;
}

export interface Branch {
  name: string;
  current: boolean;
  upstream: string;
  ahead: number;
  behind: number;
}

export interface GitError {
  command: string;
  message: string;
}

export interface Repo {
  root: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: FileChange[];
  commits: Commit[];
  branches: Branch[];
  errors: GitError[];
}

/** Run git and return stdout, or null when it fails. Never throws. */
export function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // A pager or an editor would take the terminal away from the TUI.
    env: { ...process.env, GIT_PAGER: "cat", GIT_EDITOR: "true", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

export function repoRoot(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || null;
}

/**
 * `git status --porcelain=v2 -z`. v2 rather than v1 because it reports the
 * branch, the upstream and the ahead/behind counts in the same call, and -z
 * because a path may contain anything but NUL.
 */
export function parseStatus(out: string): Pick<Repo, "branch" | "upstream" | "ahead" | "behind" | "files"> {
  const result = { branch: "", upstream: "", ahead: 0, behind: 0, files: [] as FileChange[] };
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const line = records[i] as string;
    if (line === "") continue;
    if (line.startsWith("# branch.head ")) {
      result.branch = line.slice("# branch.head ".length);
    } else if (line.startsWith("# branch.upstream ")) {
      result.upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(-?\d+) -(-?\d+)/.exec(line);
      if (m) { result.ahead = Number(m[1]); result.behind = Number(m[2]); }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const rename = line.startsWith("2 ");
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const index = xy[0] ?? ".";
      const work = xy[1] ?? ".";
      // Fields are fixed up to the path, which is the rest of the record.
      const pathStart = rename ? 9 : 8;
      const path = parts.slice(pathStart).join(" ");
      // A rename's original path is the *next* NUL-separated record.
      const from = rename ? (records[++i] as string | undefined) : undefined;
      result.files.push({
        index, work, path, from,
        staged: index !== "." && index !== " ",
        unstaged: work !== "." && work !== " ",
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      result.files.push({
        index: "U", work: "U",
        path: parts.slice(10).join(" "),
        staged: false, unstaged: true, untracked: false, conflicted: true,
      });
    } else if (line.startsWith("? ")) {
      result.files.push({
        index: "?", work: "?", path: line.slice(2),
        staged: false, unstaged: true, untracked: true, conflicted: false,
      });
    }
  }
  return result;
}

const LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%D";

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of out.split("\0")) {
    if (line === "") continue;
    const [hash, short, subject, author, when, refs] = line.split("\x1f");
    if (!hash) continue;
    commits.push({
      hash, short: short ?? "", subject: subject ?? "",
      author: author ?? "", when: when ?? "", refs: refs ?? "",
    });
  }
  return commits;
}

const BRANCH_FORMAT = "%(HEAD)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track)";

export function parseBranches(out: string): Branch[] {
  const branches: Branch[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const [head, name, upstream, track] = line.split("\x1f");
    if (!name) continue;
    const ahead = /ahead (\d+)/.exec(track ?? "");
    const behind = /behind (\d+)/.exec(track ?? "");
    branches.push({
      name,
      current: head === "*",
      upstream: upstream ?? "",
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
    });
  }
  return branches;
}

export function readRepo(cwd: string, logLimit = 200): Repo | null {
  const root = repoRoot(cwd);
  if (!root) return null;
  const errors: GitError[] = [];
  const run = (args: string[]): string => {
    const out = git(root, args);
    if (out === null) {
      errors.push({ command: `git ${args[0]}`, message: "failed" });
      return "";
    }
    return out;
  };

  // --untracked-files=all, because the default collapses a new directory to a
  // single "? sub/" entry and you cannot stage or diff a directory here.
  const status = parseStatus(
    run(["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]),
  );
  const commits = parseLog(run(["log", `--pretty=format:${LOG_FORMAT}%x00`, "-n", String(logLimit)]));
  const branches = parseBranches(run(["for-each-ref", "--sort=-committerdate",
    `--format=${BRANCH_FORMAT}`, "refs/heads"]));

  return { root, ...status, commits, branches, errors };
}

/** The diff for one path, staged or not. Empty string when there is none. */
export function fileDiff(root: string, file: FileChange, staged: boolean): string {
  if (file.untracked) {
    const out = git(root, ["diff", "--no-color", "--no-index", "/dev/null", file.path]);
    // --no-index exits 1 when the files differ, which is always here.
    return out ?? git(root, ["show", `:${file.path}`]) ?? "(untracked)";
  }
  const args = ["diff", "--no-color"];
  if (staged) args.push("--cached");
  args.push("--", file.path);
  return git(root, args) ?? "";
}

/** Colour family for a diff line, as a theme key. */
export function diffLineKind(line: string): "success" | "danger" | "accent" | "muted" | "foreground" {
  if (line.startsWith("+++") || line.startsWith("---")) return "muted";
  if (line.startsWith("@@")) return "accent";
  if (line.startsWith("+")) return "success";
  if (line.startsWith("-")) return "danger";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "muted";
  return "foreground";
}

export function stage(root: string, file: FileChange): boolean {
  return git(root, ["add", "--", file.path]) !== null;
}

export function unstage(root: string, file: FileChange): boolean {
  return git(root, ["restore", "--staged", "--", file.path]) !== null;
}
