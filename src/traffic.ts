/**
 * Traffic for this repository, from a gh-pulse report.
 *
 * GitHub only serves a repository's views and clones through its traffic API,
 * and only the last fourteen days of them. gh-pulse (profullstack/cli-tools)
 * reads that every day for every repository the login can see and writes a
 * report under ~/.local/share/gh-pulse; when one is there, the Pulse screen
 * draws this repository's series from it. Nothing is fetched here: it is a
 * file read, and a missing file is not an error.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TrafficDay {
  day: string;
  count: number;
  uniques: number;
}

export interface TrafficReferrer {
  referrer: string;
  count: number;
  uniques: number;
}

export interface TrafficPath {
  path: string;
  count: number;
  uniques: number;
}

export interface Traffic {
  repo: string;
  url: string;
  /** When the report was written. */
  reportAt: string;
  stars: number;
  forks: number;
  views14d: TrafficDay[];
  clones14d: TrafficDay[];
  referrers: TrafficReferrer[];
  paths: TrafficPath[];
}

export function ghPulseDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["GH_PULSE_DATA"] ?? join(homedir(), ".local", "share", "gh-pulse");
}

export function ghPulseReportPath(dir: string = ghPulseDataDir()): string {
  return join(dir, "out", "latest.json");
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

function days(v: unknown): TrafficDay[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).map((d) => ({ day: str(d["day"]), count: num(d["count"]), uniques: num(d["uniques"]) }));
}

/**
 * The repository's row out of a gh-pulse report. The report only carries the
 * repositories that moved, so a quiet one is null even when the report is
 * fresh, and every field is read defensively: the report is another tool's
 * output, not this one's.
 */
export function trafficFromReport(report: unknown, repo: string): Traffic | null {
  if (!isRecord(report) || !Array.isArray(report["movers"])) return null;
  const want = repo.toLowerCase();
  const mover = report["movers"].find((m) => isRecord(m) && str(m["repo"]).toLowerCase() === want);
  if (!isRecord(mover)) return null;
  const name = str(mover["repo"]);
  return {
    repo: name,
    url: str(mover["url"]) || `https://github.com/${name}`,
    reportAt: str(report["at"]),
    stars: num(mover["stars"]),
    forks: num(mover["forks"]),
    views14d: days(mover["views14d"]),
    clones14d: days(mover["clones14d"]),
    referrers: Array.isArray(mover["referrers"])
      ? mover["referrers"].filter(isRecord).map((r) => ({ referrer: str(r["referrer"]), count: num(r["count"]), uniques: num(r["uniques"]) }))
      : [],
    paths: Array.isArray(mover["paths"])
      ? mover["paths"].filter(isRecord).map((p) => ({ path: str(p["path"]), count: num(p["count"]), uniques: num(p["uniques"]) }))
      : [],
  };
}

export function readTraffic(repo: string, dir: string = ghPulseDataDir()): Traffic | null {
  const file = ghPulseReportPath(dir);
  if (!existsSync(file)) return null;
  try {
    return trafficFromReport(JSON.parse(readFileSync(file, "utf8")), repo);
  } catch {
    return null;
  }
}
