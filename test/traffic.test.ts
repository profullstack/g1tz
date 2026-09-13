import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghPulseDataDir, ghPulseReportPath, readTraffic, trafficFromReport } from "../src/traffic.ts";

const REPORT = {
  at: "2026-09-13T03:05:36.694Z",
  movers: [
    {
      repo: "profullstack/g1tz",
      url: "https://github.com/profullstack/g1tz",
      stars: 3,
      forks: 1,
      views14d: [{ day: "2026-09-10", count: 4, uniques: 2 }, { day: "2026-09-11", count: 0, uniques: 0 }],
      clones14d: [{ day: "2026-09-10", count: 3, uniques: 3 }],
      referrers: [{ referrer: "hqtui.com", count: 2, uniques: 1 }],
      paths: [{ path: "/profullstack/g1tz", count: 4, uniques: 2 }],
    },
    { repo: "other/quiet" },
  ],
};

function dataDir(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-pulse-"));
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", "latest.json"), typeof report === "string" ? report : JSON.stringify(report));
  return dir;
}

test("the repository's row is read out of the report, whatever its case", () => {
  const t = readTraffic("ProFullStack/G1TZ", dataDir(REPORT));
  assert.ok(t);
  assert.equal(t.repo, "profullstack/g1tz");
  assert.equal(t.reportAt, "2026-09-13T03:05:36.694Z");
  assert.deepEqual(t.views14d.map((d) => d.count), [4, 0]);
  assert.equal(t.clones14d[0]?.uniques, 3);
  assert.equal(t.referrers[0]?.referrer, "hqtui.com");
  assert.equal(t.paths[0]?.path, "/profullstack/g1tz");
});

test("a repository that did not move is not in the report, and that is null rather than an error", () => {
  assert.equal(readTraffic("profullstack/nixamp", dataDir(REPORT)), null);
});

test("a missing or broken report is null", () => {
  assert.equal(readTraffic("profullstack/g1tz", join(tmpdir(), "no-such-gh-pulse-dir")), null);
  assert.equal(readTraffic("profullstack/g1tz", dataDir("{not json")), null);
  assert.equal(trafficFromReport(null, "x"), null);
  assert.equal(trafficFromReport({ movers: "nope" }, "x"), null);
});

test("a thin row still reads, with the fields it lacks empty", () => {
  const t = trafficFromReport({ at: "", movers: [{ repo: "other/quiet" }] }, "other/quiet");
  assert.ok(t);
  assert.equal(t.url, "https://github.com/other/quiet");
  assert.deepEqual(t.views14d, []);
  assert.deepEqual(t.referrers, []);
});

test("the data dir follows GH_PULSE_DATA, like gh-pulse itself", () => {
  assert.equal(ghPulseDataDir({ GH_PULSE_DATA: "/elsewhere" }), "/elsewhere");
  assert.match(ghPulseDataDir({}), /\.local\/share\/gh-pulse$/);
  assert.equal(ghPulseReportPath("/d"), "/d/out/latest.json");
});
