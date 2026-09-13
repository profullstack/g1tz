/**
 * Pulse: what moved in this repository over a period, read from git.
 *
 * The same idea as GitHub's Insights > Pulse tab, worked out locally so it is
 * there offline and for repositories that are not on GitHub at all: commits
 * and authors on the current branch and across every branch, the net change
 * to the tree since the period began, the branches that saw commits and the
 * tags that were created. GitHub's own side (pull requests, issues, stars and
 * releases) is an optional, separate read in github.ts; views and clones come
 * from a gh-pulse report when one exists (traffic.ts).
 *
 * Everything here is read-only, which is why the file list can afford
 * display-grade path handling: a munged path on this screen cannot touch the
 * working tree, unlike one in the Files pane.
 */
import { git, type GitError } from "./git.ts";

export const RANGE_KEYS = ["day", "week", "month", "quarter", "year", "all"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

const DAY_MS = 86_400_000;
export const RANGE_MS: Record<RangeKey, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 91 * DAY_MS,
  year: 365 * DAY_MS,
  all: Number.POSITIVE_INFINITY,
};
export const RANGE_LABEL: Record<RangeKey, string> = {
  day: "last 24 hours",
  week: "last week",
  month: "last month",
  quarter: "last quarter",
  year: "last year",
  all: "all time",
};
export const RANGE_HOTKEY: Record<RangeKey, string> = { day: "d", week: "w", month: "m", quarter: "q", year: "y", all: "a" };

const RANGE_ALIASES: Record<string, RangeKey> = {
  "24h": "day", "1d": "day", today: "day",
  "7d": "week", "1w": "week",
  "30d": "month", "1m": "month",
  "90d": "quarter", "3m": "quarter",
  "365d": "year", "1y": "year", "12m": "year",
  ever: "all", forever: "all",
};

export function parseRangeKey(text: string): RangeKey | null {
  const key = text.trim().toLowerCase();
  if ((RANGE_KEYS as readonly string[]).includes(key)) return key as RangeKey;
  return RANGE_ALIASES[key] ?? null;
}

export function rangeForHotkey(key: string): RangeKey | null {
  return RANGE_KEYS.find((k) => RANGE_HOTKEY[k] === key) ?? null;
}

/** The start of a range, or null for all time. */
export function sinceFor(range: RangeKey, now: Date): Date | null {
  return range === "all" ? null : new Date(now.getTime() - RANGE_MS[range]);
}

export interface PulseCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  /** Committer date, ISO 8601. --since selects on it, so a bucket never falls outside the range. */
  at: string;
  subject: string;
  merge: boolean;
}

export interface PulseAuthor {
  name: string;
  commits: number;
}

export interface PulseFile {
  path: string;
  /** Original path for a rename. */
  from?: string;
  added: number;
  deleted: number;
  binary: boolean;
}

export interface PulseRef {
  name: string;
  at: string;
}

export type BucketUnit = "hour" | "day" | "week" | "month";

export interface Bucket {
  label: string;
  /** ISO start of the bucket. */
  start: string;
  count: number;
}

export interface Pulse {
  range: RangeKey;
  /** ISO start of the period, or null for all time. */
  since: string | null;
  until: string;
  branch: string;
  /** Every commit reachable from HEAD in the period, merges included, newest first. */
  commits: PulseCommit[];
  commitsTruncated: boolean;
  /** Commits on every local branch in the period, merges excluded. */
  allBranchCommits: number;
  /** Merges excluded, busiest first. */
  authors: PulseAuthor[];
  filesChanged: number;
  additions: number;
  deletions: number;
  /** The net change per file since the period began, biggest first. */
  files: PulseFile[];
  unit: BucketUnit;
  buckets: Bucket[];
  /** Local branches that received a commit in the period. */
  branches: PulseRef[];
  /** Tags created in the period. */
  tags: PulseRef[];
  errors: GitError[];
}

// ---------------------------------------------------------------- parsers

const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%cI%x1f%P%x1f%s";

/** `git log --format=<fields>%x00`: one NUL-terminated record per commit, fields separated by 0x1f. */
export function parsePulseLog(out: string): PulseCommit[] {
  const commits: PulseCommit[] = [];
  for (const raw of out.split("\0")) {
    // A newline between records is separator noise, not part of the hash.
    const record = raw.replace(/^\n/, "");
    if (record === "") continue;
    const [hash, short, author, email, at, parents, subject] = record.split("\x1f");
    if (!hash) continue;
    commits.push({
      hash,
      short: short ?? "",
      author: author ?? "",
      email: email ?? "",
      at: at ?? "",
      subject: subject ?? "",
      merge: (parents ?? "").split(" ").filter(Boolean).length > 1,
    });
  }
  return commits;
}

/**
 * `git diff --numstat -z`: `added TAB deleted TAB path NUL`. A rename is
 * `added TAB deleted TAB NUL old NUL new NUL`, and a binary file has `-` for
 * both counts. Paths are raw, so one with a newline in it still parses.
 */
export function parseNumstat(out: string): PulseFile[] {
  const files: PulseFile[] = [];
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === "") continue;
    const m = /^(\d+|-)\t(\d+|-)\t([^]*)$/.exec(token);
    if (!m) continue;
    const binary = m[1] === "-";
    const added = binary ? 0 : Number(m[1]);
    const deleted = binary ? 0 : Number(m[2]);
    if (m[3] === "") {
      // A rename: the two paths follow as their own records.
      const from = tokens[++i] ?? "";
      const path = tokens[++i] ?? "";
      files.push({ path, from, added, deleted, binary });
    } else {
      files.push({ path: m[3] as string, added, deleted, binary });
    }
  }
  return files;
}

/** `git diff --shortstat`: " 3 files changed, 12 insertions(+), 4 deletions(-)", any part of which may be missing. */
export function parseShortstat(out: string): { filesChanged: number; additions: number; deletions: number } {
  const files = /(\d+) files? changed/.exec(out);
  const ins = /(\d+) insertions?\(\+\)/.exec(out);
  const del = /(\d+) deletions?\(-\)/.exec(out);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    additions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/** `git for-each-ref --format=%(refname:short)%1f%(<date>:iso-strict)`, one ref per line. */
export function parseRefDates(out: string): PulseRef[] {
  const refs: PulseRef[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const [name, at] = line.split("\x1f");
    if (name) refs.push({ name, at: at ?? "" });
  }
  return refs;
}

export function refsSince(refs: PulseRef[], since: Date | null): PulseRef[] {
  if (!since) return refs;
  return refs.filter((r) => Date.parse(r.at) >= since.getTime());
}

/** Merges excluded, as GitHub counts them; busiest first, then by name. */
export function countAuthors(commits: readonly PulseCommit[]): PulseAuthor[] {
  const counts = new Map<string, number>();
  for (const c of commits) {
    if (c.merge) continue;
    counts.set(c.author, (counts.get(c.author) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, n]) => ({ name, commits: n }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- buckets

export function unitFor(range: RangeKey): BucketUnit {
  switch (range) {
    case "day": return "hour";
    case "week": case "month": return "day";
    case "quarter": case "year": return "week";
    default: return "month";
  }
}

/** The start of the bucket holding `time`, in UTC. Weeks start on Monday. */
function floorTo(time: number, unit: BucketUnit): Date {
  const t = new Date(time);
  t.setUTCMinutes(0, 0, 0);
  if (unit === "hour") return t;
  t.setUTCHours(0);
  if (unit === "day") return t;
  if (unit === "week") {
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return t;
  }
  t.setUTCDate(1);
  return t;
}

function next(t: Date, unit: BucketUnit): Date {
  const n = new Date(t.getTime());
  if (unit === "hour") n.setUTCHours(n.getUTCHours() + 1);
  else if (unit === "day") n.setUTCDate(n.getUTCDate() + 1);
  else if (unit === "week") n.setUTCDate(n.getUTCDate() + 7);
  else n.setUTCMonth(n.getUTCMonth() + 1);
  return n;
}

function labelFor(t: Date, unit: BucketUnit): string {
  const iso = t.toISOString();
  if (unit === "hour") return `${iso.slice(11, 13)}:00`;
  if (unit === "month") return iso.slice(0, 7);
  return iso.slice(5, 10);
}

/** More buckets than this and the range is not one anybody can read; the newest ones win. */
export const BUCKET_CAP = 2000;

/**
 * Contiguous buckets from the start of the period (or the first commit, for
 * all time) to now, with the commits counted into them. Every bucket is
 * present even when empty, so a quiet week shows as a gap rather than
 * vanishing.
 */
export function bucketCommits(commits: readonly PulseCommit[], since: Date | null, until: Date, unit: BucketUnit): Bucket[] {
  const times: number[] = [];
  let earliest = Number.POSITIVE_INFINITY;
  for (const c of commits) {
    const t = Date.parse(c.at);
    if (!Number.isFinite(t)) continue;
    times.push(t);
    if (t < earliest) earliest = t;
  }
  const from = since ? since.getTime() : times.length ? earliest : until.getTime();
  const buckets: Bucket[] = [];
  const starts: number[] = [];
  for (let t = floorTo(from, unit); t.getTime() <= until.getTime() && buckets.length < BUCKET_CAP; t = next(t, unit)) {
    buckets.push({ label: labelFor(t, unit), start: t.toISOString(), count: 0 });
    starts.push(t.getTime());
  }
  for (const time of times) {
    // The last bucket starting at or before this commit; a commit from the
    // future (a wrong clock) lands in the newest one.
    let lo = 0;
    let hi = starts.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] as number) <= time) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx >= 0) (buckets[idx] as Bucket).count += 1;
  }
  return buckets;
}

/** At most `max` buckets, merging neighbours; a group takes the label of its first. */
export function foldBuckets(buckets: readonly Bucket[], max: number): Bucket[] {
  if (max < 1 || buckets.length <= max) return [...buckets];
  const per = Math.ceil(buckets.length / max);
  const out: Bucket[] = [];
  for (let i = 0; i < buckets.length; i += per) {
    const group = buckets.slice(i, i + per);
    const first = group[0] as Bucket;
    out.push({ label: first.label, start: first.start, count: group.reduce((t, b) => t + b.count, 0) });
  }
  return out;
}

// ---------------------------------------------------------------- reading

/** The hash of the empty tree, so the diff for all time (or from a root commit) has something to diff against. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const COMMIT_CAP = 50_000;
export const FILE_CAP = 500;

const churn = (f: PulseFile): number => f.added + f.deleted;

export function readPulse(root: string, range: RangeKey, now: Date = new Date()): Pulse {
  const since = sinceFor(range, now);
  const sinceArgs = since ? [`--since=${since.toISOString()}`] : [];
  const errors: GitError[] = [];
  const run = (args: string[]): string => {
    const out = git(root, args);
    if (out === null) {
      errors.push({ command: `git ${args[0]}`, message: "failed" });
      return "";
    }
    return out;
  };

  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() ?? "";
  // An unborn HEAD (a repository with no commits yet) fails every read below;
  // the pulse is then simply empty rather than a list of errors.
  const hasHead = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) !== null;

  const commits = hasHead
    ? parsePulseLog(run(["log", `--format=${LOG_FORMAT}%x00`, `--max-count=${COMMIT_CAP}`, ...sinceArgs, "HEAD"]))
    : [];
  const allBranchCommits = hasHead
    ? Number(run(["rev-list", "--branches", "--no-merges", "--count", ...sinceArgs]).trim()) || 0
    : 0;

  // The tree at the start of the period is the first parent of the oldest
  // first-parent commit in range: what the branch pointed at before any of
  // this landed, whether it arrived by merge, rebase or fast-forward. All
  // time, and a root commit inside the period, diff from the empty tree.
  let boundary: string | null = null;
  if (hasHead) {
    if (!since) boundary = EMPTY_TREE;
    else {
      const oldest = run(["rev-list", "--first-parent", ...sinceArgs, "HEAD"]).trim().split("\n").filter(Boolean).at(-1);
      if (oldest) boundary = git(root, ["rev-parse", "--verify", "--quiet", `${oldest}^`])?.trim() || EMPTY_TREE;
    }
  }
  let filesChanged = 0;
  let additions = 0;
  let deletions = 0;
  let files: PulseFile[] = [];
  if (boundary) {
    ({ filesChanged, additions, deletions } = parseShortstat(run(["diff", "--shortstat", "-M", boundary, "HEAD"])));
    files = parseNumstat(run(["diff", "--numstat", "-z", "-M", boundary, "HEAD"]))
      .sort((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path))
      .slice(0, FILE_CAP);
  }

  const branches = refsSince(parseRefDates(run([
    "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%1f%(committerdate:iso-strict)", "refs/heads",
  ])), since);
  const tags = refsSince(parseRefDates(run([
    "for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%1f%(creatordate:iso-strict)", "refs/tags",
  ])), since);

  const unit = unitFor(range);
  return {
    range,
    since: since ? since.toISOString() : null,
    until: now.toISOString(),
    branch,
    commits,
    commitsTruncated: commits.length >= COMMIT_CAP,
    allBranchCommits,
    authors: countAuthors(commits),
    filesChanged,
    additions,
    deletions,
    files,
    unit,
    buckets: bucketCommits(commits, since, now, unit),
    branches,
    tags,
    errors,
  };
}
