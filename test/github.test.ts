import { test } from "node:test";
import assert from "node:assert/strict";
import { ghErrorMessage, parseGitHubRemote, readGitHubPulse, type Fetch } from "../src/github.ts";

const SINCE = new Date("2026-09-06T00:00:00Z");
const before = "2026-09-01T00:00:00Z";
const inside = "2026-09-10T00:00:00Z";

/** A GitHub that answers from a table of path prefixes, recording every request. */
function fake(pages: Record<string, unknown>): { fetch: Fetch; requests: string[] } {
  const requests: string[] = [];
  const fetch: Fetch = async (path) => {
    requests.push(path);
    const key = Object.keys(pages).find((k) => path.startsWith(k) && (path.length === k.length || "?&".includes(path[k.length] ?? "")));
    if (key === undefined) throw new Error(`unexpected request ${path}`);
    const answer = pages[key];
    return typeof answer === "function" ? (answer as (p: string) => unknown)(path) : answer;
  };
  return { fetch, requests };
}

const pageOf = (path: string): number => Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);

test("GitHub remotes are recognised in every spelling, and nothing else is", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/profullstack/g1tz.git"), { owner: "profullstack", name: "g1tz" });
  assert.deepEqual(parseGitHubRemote("git@github.com:profullstack/g1tz.git"), { owner: "profullstack", name: "g1tz" });
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/profullstack/g1tz"), { owner: "profullstack", name: "g1tz" });
  assert.deepEqual(parseGitHubRemote("https://github.com/o/n/\n"), { owner: "o", name: "n" });
  assert.deepEqual(parseGitHubRemote("https://user@github.com/o/n"), { owner: "o", name: "n" });
  assert.deepEqual(parseGitHubRemote("ssh://git@ssh.github.com:443/o/n.git"), { owner: "o", name: "n" }, "SSH over the HTTPS port");
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com:22/o/n.git"), { owner: "o", name: "n" });
  assert.deepEqual(parseGitHubRemote("git@github.com:12345/n.git"), { owner: "12345", name: "n" }, "a numeric owner is not a port");
  assert.equal(parseGitHubRemote("https://gitlab.com/o/n.git"), null);
  assert.equal(parseGitHubRemote(""), null);
});

test("a stargazers page GitHub refuses costs the star count, not the read", async () => {
  const { fetch } = fake({
    "repos/o/r": { stargazers_count: 250000 },
    "repos/o/r/pulls": [{ number: 1, title: "kept", user: { login: "ann" }, created_at: inside, updated_at: inside, closed_at: null, merged_at: null }],
    "repos/o/r/issues": [],
    "repos/o/r/releases": [],
    "repos/o/r/stargazers": () => { throw new Error("repository not found on GitHub, or the gh login cannot see it"); },
  });
  const g = await readGitHubPulse({ owner: "o", name: "r" }, SINCE, fetch);
  assert.equal(g.prsOpened.length, 1, "what was already fetched survives");
  assert.equal(g.newStars, 0);
  assert.equal(g.partial, true, "and the count is marked as a floor");
});

test("a release published in the period is found even when it is listed below older ones", async () => {
  // GitHub lists releases by the tagged commit's date: a release cut this week for an old tag sits low.
  const { fetch } = fake({
    "repos/o/r": { stargazers_count: 0 },
    "repos/o/r/pulls": [],
    "repos/o/r/issues": [],
    "repos/o/r/releases": [
      { tag_name: "v1.0.0", name: "one", published_at: before, created_at: before },
      { tag_name: "v0.9.1", name: "backport", published_at: inside, created_at: "2026-07-01T00:00:00Z" },
    ],
  });
  const g = await readGitHubPulse({ owner: "o", name: "r" }, SINCE, fetch);
  assert.deepEqual(g.releases.map((r) => r.tag), ["v0.9.1"]);
});

test("pull requests, issues, releases and stars are sorted into the period", async () => {
  const { fetch, requests } = fake({
    "repos/o/r": { stargazers_count: 150, forks_count: 4, open_issues_count: 7, html_url: "https://github.com/o/r", description: "d" },
    "repos/o/r/pulls": [
      { number: 3, title: "merged now", user: { login: "ann" }, created_at: before, updated_at: inside, closed_at: inside, merged_at: inside },
      { number: 2, title: "opened now", user: { login: "bo" }, created_at: inside, updated_at: inside, closed_at: null, merged_at: null },
      { number: 1, title: "closed unmerged", user: { login: "cy" }, created_at: before, updated_at: inside, closed_at: inside, merged_at: null },
      { number: 0, title: "old", user: { login: "di" }, created_at: before, updated_at: before, closed_at: before, merged_at: before },
    ],
    "repos/o/r/issues": [
      { number: 9, title: "a pr in disguise", user: { login: "x" }, created_at: inside, updated_at: inside, closed_at: null, pull_request: {} },
      { number: 8, title: "new issue", user: { login: "ed" }, created_at: inside, updated_at: inside, closed_at: null },
      { number: 7, title: "old but closed now", user: { login: "fi" }, created_at: before, updated_at: inside, closed_at: inside },
    ],
    "repos/o/r/releases": [
      { tag_name: "v2", name: "two", published_at: inside, created_at: inside },
      { tag_name: "v1.9", name: null, published_at: inside, created_at: inside, draft: true },
      { tag_name: "v1", name: "one", published_at: before, created_at: before },
    ],
    "repos/o/r/stargazers": (path: string) => (pageOf(path) === 2
      ? [{ starred_at: before }, { starred_at: inside }, { starred_at: inside }]
      : Array.from({ length: 100 }, () => ({ starred_at: before }))),
  });
  const g = await readGitHubPulse({ owner: "o", name: "r" }, SINCE, fetch);
  assert.equal(g.repo, "o/r");
  assert.equal(g.stars, 150);
  assert.equal(g.openIssues, 7);
  assert.deepEqual(g.prsMerged.map((p) => p.number), [3]);
  assert.deepEqual(g.prsOpened.map((p) => p.number), [2]);
  assert.deepEqual(g.prsClosed.map((p) => p.number), [1]);
  assert.deepEqual(g.issuesOpened.map((i) => i.number), [8]);
  assert.deepEqual(g.issuesClosed.map((i) => i.number), [7]);
  assert.deepEqual(g.releases.map((r) => r.tag), ["v2"], "drafts and older releases are left out");
  assert.equal(g.newStars, 2, "counted from the last page backwards until an older star");
  assert.equal(g.partial, false);
  assert.ok(requests.some((p) => p.startsWith("repos/o/r/stargazers?per_page=100&page=2")), "the last page is asked for first");
  assert.ok(!requests.some((p) => p.startsWith("repos/o/r/stargazers?per_page=100&page=1")), "the older page is never needed");
  assert.ok(!requests.some((p) => p.includes("/pulls?") && pageOf(p) === 2), "a short page ends the walk");
});

test("a walk that runs out of pages says the counts are floors", async () => {
  const full = () => Array.from({ length: 100 }, (_, i) => ({ number: i, title: "t", created_at: inside, updated_at: inside, closed_at: null, merged_at: null }));
  const { fetch } = fake({
    "repos/o/r": { stargazers_count: 0 },
    "repos/o/r/pulls": full,
    "repos/o/r/issues": [],
    "repos/o/r/releases": [],
  });
  const g = await readGitHubPulse({ owner: "o", name: "r" }, SINCE, fetch, { pulls: 2, issues: 1, releases: 1, stars: 1 });
  assert.equal(g.prsOpened.length, 200);
  assert.equal(g.partial, true);
});

test("all time takes the star total without walking the stargazers", async () => {
  const { fetch, requests } = fake({
    "repos/o/r": { stargazers_count: 42 },
    "repos/o/r/pulls": [],
    "repos/o/r/issues": [],
    "repos/o/r/releases": [],
  });
  const g = await readGitHubPulse({ owner: "o", name: "r" }, null, fetch);
  assert.equal(g.newStars, 42);
  assert.ok(!requests.some((p) => p.includes("stargazers")));
  assert.ok(!requests.some((p) => p.includes("since=")), "no since for all time");
});

test("gh's failures are turned into one plain sentence", () => {
  const err = (code?: string): NodeJS.ErrnoException => Object.assign(new Error("boom"), code ? { code } : {});
  assert.equal(ghErrorMessage(err("ENOENT"), ""), "gh is not installed");
  assert.match(ghErrorMessage(err(), "To get started with GitHub CLI, please run:  gh auth login"), /not logged in/);
  assert.match(ghErrorMessage(err(), "gh: Not Found (HTTP 404)"), /not found on GitHub/);
  assert.match(ghErrorMessage(err(), "gh: API rate limit exceeded (HTTP 403)"), /rate limit/);
  assert.equal(ghErrorMessage(err(), "something else\nmore"), "something else");
  assert.equal(ghErrorMessage(err(), ""), "boom");
  // execFile's own timeout: no stderr, a signal, and a message nobody should read.
  assert.match(ghErrorMessage(Object.assign(new Error("Command failed: gh api x"), { code: null, signal: "SIGTERM", killed: true }), ""), /did not answer in time/);
});
