/** Render the Team screen from a real server: G1TZ_URL and G1TZ_TOKEN must be set. */
import { renderToText } from "@profullstack/hqtui/testing";
import { cloudConfig } from "../src/account.ts";
import { createTeamState, loadTeam, teamView } from "../src/team-view.ts";

const state = createTeamState();
await loadTeam(state, cloudConfig(), () => {});
console.log(renderToText((args) => teamView(args as never, state), { width: Number(process.argv[2] ?? 120), height: Number(process.argv[3] ?? 30) }));
if (state.status !== "ready") { console.error(`status ${state.status}: ${state.note}`); process.exit(1); }
