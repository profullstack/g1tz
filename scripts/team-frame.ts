/** Print one Team screen frame from fixture data, for eyeballing the layout. */
import { renderToText } from "@profullstack/hqtui/testing";
import { createTeamState, teamView } from "../src/team-view.ts";
import { entitlements } from "../src/teams-model.ts";

const s = createTeamState("https://g1tz.hqtui.com");
s.status = "ready";
s.data = {
  me: { email: "ann@acme.test", displayName: "Ann" },
  org: { id: "o1", name: "Acme", plan: "pro", role: "owner", seats: { used: 2, pending: 1, seats: 2, cap: 2, free: 0 }, domains: [] },
  members: [
    { email: "ann@acme.test", displayName: "Ann", role: "owner", teams: [] },
    { email: "bo@acme.test", displayName: "Bo", role: "user", teams: [] },
    { email: "cash@acme.test", displayName: "Cash", role: "billing", teams: [] },
  ],
  invitations: [{ email: "dee@acme.test", role: "user" }],
  teams: [],
  workspaces: [{ id: "w1", name: "Everything", team: null, description: "", repos: [{ url: "https://github.com/acme/site", name: "site" }] }],
  entitlements: entitlements("pro"),
};
const width = Number(process.argv[2] ?? 120);
const height = Number(process.argv[3] ?? 32);
console.log(renderToText((args) => teamView(args as never, s), { width, height }));
