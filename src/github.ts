/**
 * The GitHub half of Pulse: pull requests, issues, releases and stars over the
 * period, read through the gh CLI. gh holds the login, so nothing here ever
 * sees a token, and a machine without gh (or without a login) simply gets the
 * git half on its own.
 *
 * Pages are walked newest-first and stop at the first item older than the
 * period, under a small page budget, so a busy repository on "all time"
 * cannot turn one keypress into a thousand requests. When the budget runs out
 * the counts are floors and the result says so.
 */
import { execFile, spawnSync } from "node:child_process";
import { git } from "./git.ts";

export interface GitHubRepo {
  owner: string;
  name: string;
}

export interface GitHubItem {
  number: number;
  title: string;
  user: string;
  /** ISO date of the event this item is listed for: opened, merged or closed. */
  at: string;
}

export interface GitHubRelease {
  tag: string;
  name: string;
  at: string;
}

export interface GitHubPulse {
  repo: string;
  url: string;
  description: string;
  stars: number;
  forks: number;
  /** GitHub's open issue count, which includes open pull requests. */
  openIssues: number;
  prsOpened: GitHubItem[];
  prsMerged: GitHubItem[];
  /** Closed without merging. */
  prsClosed: GitHubItem[];
  issuesOpened: GitHubItem[];
  issuesClosed: GitHubItem[];
  releases: GitHubRelease[];
  newStars: number;
  /** A page budget ran out somewhere, so a count is a floor rather than a total. */
  partial: boolean;
}

/** https, ssh and scp-style GitHub remotes, with or without .git. Anything else is null. */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/(?:git@)?)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1] as string, name: m[2] as string } : null;
}

export function githubRemote(root: string): GitHubRepo | null {
  const url = git(root, ["remote", "get-url", "origin"]);
  return url ? parseGitHubRemote(url) : null;
}

export const repoName = (repo: GitHubRepo): string => `${repo.owner}/${repo.name}`;

/** One GitHub API call: a path relative to the API root, parsed JSON back. */
export type Fetch = (path: string, headers?: Record<string, string>) => Promise<unknown>;

let ghPresent: boolean | null = null;

/** Whether gh is on the PATH. Asked once per process. */
export function ghInstalled(): boolean {
  if (ghPresent === null) ghPresent = spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
  return ghPresent;
}

/** What to tell the user when gh could not answer. */
export function ghErrorMessage(error: { code?: string | number | undefined; message: string }, stderr: string): string {
  if (error.code === "ENOENT") return "gh is not installed";
  const s = stderr.trim();
  if (/gh auth login|not logged in|authentication required|HTTP 401/i.test(s)) return "gh is not logged in (run gh auth login)";
  if (/rate limit/i.test(s)) return "GitHub API rate limit exceeded; try again later";
  if (/HTTP 404/.test(s)) return "repository not found on GitHub, or the gh login cannot see it";
  return s.split("\n")[0] || error.message;
}

export function ghFetch(path: string, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ["api", path];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    execFile("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(ghErrorMessage(error, stderr)));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("gh returned something that is not JSON"));
      }
    });
  });
}

export interface PageBudget {
  pulls: number;
  issues: number;
  releases: number;
  stars: number;
}

export const PAGE_BUDGET: PageBudget = { pulls: 5, issues: 5, releases: 2, stars: 3 };

interface UserJson { login?: string }
interface PullJson { number: number; title: string; user?: UserJson; created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null }
interface IssueJson { number: number; title: string; user?: UserJson; created_at: string; updated_at: string; closed_at: string | null; pull_request?: unknown }
interface ReleaseJson { tag_name: string; name: string | null; published_at: string | null; created_at: string; draft?: boolean }
interface StarJson { starred_at: string }
interface RepoJson { stargazers_count?: number; forks_count?: number; open_issues_count?: number; html_url?: string; description?: string | null }

const STAR_HEADERS = { Accept: "application/vnd.github.star+json" };

/** Walk numbered pages until `stop` says an item is older than needed, a short page ends the list, or the budget is spent. */
async function walk<T>(fetch: Fetch, path: string, pages: number, stop: (item: T) => boolean): Promise<{ items: T[]; partial: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= pages; page++) {
    const data = (await fetch(`${path}&page=${page}`)) as T[];
    if (!Array.isArray(data) || data.length === 0) return { items, partial: false };
    for (const item of data) {
      if (stop(item)) return { items, partial: false };
      items.push(item);
    }
    if (data.length < 100) return { items, partial: false };
  }
  return { items, partial: true };
}

/** GitHub lists stargazers oldest first, so the count of new ones starts at the last page and walks back. */
async function countStars(fetch: Fetch, name: string, total: number, cutoff: number, pages: number): Promise<{ count: number; partial: boolean }> {
  if (cutoff === 0 || total === 0) return { count: total, partial: false };
  const lastPage = Math.max(1, Math.ceil(total / 100));
  let count = 0;
  for (let page = lastPage, used = 0; page >= 1; page--, used++) {
    if (used >= pages) return { count, partial: true };
    const data = (await fetch(`repos/${name}/stargazers?per_page=100&page=${page}`, STAR_HEADERS)) as StarJson[];
    if (!Array.isArray(data)) return { count, partial: false };
    for (let i = data.length - 1; i >= 0; i--) {
      if (Date.parse((data[i] as StarJson).starred_at) < cutoff) return { count, partial: false };
      count++;
    }
  }
  return { count, partial: false };
}

const item = (x: { number: number; title: string; user?: UserJson }, at: string): GitHubItem =>
  ({ number: x.number, title: x.title, user: x.user?.login ?? "", at });
const newest = (a: GitHubItem, b: GitHubItem): number => b.at.localeCompare(a.at);

export async function readGitHubPulse(repo: GitHubRepo, since: Date | null, fetch: Fetch = ghFetch, budget: PageBudget = PAGE_BUDGET): Promise<GitHubPulse> {
  const name = repoName(repo);
  const cutoff = since ? since.getTime() : 0;
  const inRange = (iso: string | null | undefined): boolean => iso !== null && iso !== undefined && Date.parse(iso) >= cutoff;
  const stale = (iso: string | null | undefined): boolean => !inRange(iso);

  const info = (await fetch(`repos/${name}`)) as RepoJson;
  // Sorted by last update, newest first: the first one untouched in the period ends the walk.
  const pulls = await walk<PullJson>(fetch, `repos/${name}/pulls?state=all&sort=updated&direction=desc&per_page=100`, budget.pulls, (p) => stale(p.updated_at));
  const sinceParam = since ? `&since=${since.toISOString()}` : "";
  const issues = await walk<IssueJson>(fetch, `repos/${name}/issues?state=all&sort=updated&direction=desc&per_page=100${sinceParam}`, budget.issues, (i) => stale(i.updated_at));
  const releases = await walk<ReleaseJson>(fetch, `repos/${name}/releases?per_page=100`, budget.releases, (r) => stale(r.published_at ?? r.created_at));
  const stars = await countStars(fetch, name, info.stargazers_count ?? 0, cutoff, budget.stars);

  return {
    repo: name,
    url: info.html_url ?? `https://github.com/${name}`,
    description: info.description ?? "",
    stars: info.stargazers_count ?? 0,
    forks: info.forks_count ?? 0,
    openIssues: info.open_issues_count ?? 0,
    prsOpened: pulls.items.filter((p) => inRange(p.created_at)).map((p) => item(p, p.created_at)).sort(newest),
    prsMerged: pulls.items.filter((p) => inRange(p.merged_at)).map((p) => item(p, p.merged_at as string)).sort(newest),
    prsClosed: pulls.items.filter((p) => !p.merged_at && inRange(p.closed_at)).map((p) => item(p, p.closed_at as string)).sort(newest),
    issuesOpened: issues.items.filter((i) => !i.pull_request && inRange(i.created_at)).map((i) => item(i, i.created_at)).sort(newest),
    issuesClosed: issues.items.filter((i) => !i.pull_request && inRange(i.closed_at)).map((i) => item(i, i.closed_at as string)).sort(newest),
    releases: releases.items.filter((r) => !r.draft).map((r) => ({ tag: r.tag_name, name: r.name ?? r.tag_name, at: r.published_at ?? r.created_at })),
    newStars: stars.count,
    partial: pulls.partial || issues.partial || releases.partial || stars.partial,
  };
}
