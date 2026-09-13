/**
 * g1tz: a git TUI that shows you the repository, not a menu of git commands.
 *
 *   bunx @profullstack/g1tz                        # the repository in the working directory
 *   bunx @profullstack/g1tz ~/proj                 # somewhere else
 *   bunx @profullstack/g1tz pulse [--range month]  # start on the Pulse screen
 *
 * Files, branches and log on the left; the diff for whatever is selected on
 * the right. Space stages and unstages. `p` flips to Pulse: what moved in the
 * repository over a period, from git, from GitHub when gh is logged in, and
 * from a gh-pulse report when one exists on the machine.
 */
import { createApp, elevate, themes, type Container, type KeyEvent, type Theme } from "@profullstack/hqtui";
import { resolve } from "node:path";
import {
  fileDiff, git, readRepo, stage, unstage,
  type FileChange, type Repo,
} from "./git.ts";
import { highlightDiff, type DiffPalette } from "./diff.ts";
import { ghFetch, ghInstalled, githubRemote, readGitHubPulse, repoName, type Fetch, type GitHubRepo } from "./github.ts";
import { RANGE_KEYS, parseRangeKey, rangeForHotkey, readPulse, sinceFor, type RangeKey } from "./pulse.ts";
import { NO_ACTIONS, clampOffset, createPulseState, pulseView, type PulseActions, type PulseState } from "./pulse-view.ts";
import { readTraffic } from "./traffic.ts";

export type PaneName = "files" | "branches" | "log";
export type Screen = "repo" | "pulse";

export interface State {
  repo: Repo;
  /** The origin remote, when it is on GitHub. */
  github: GitHubRepo | null;
  screen: Screen;
  pane: PaneName;
  selected: Record<PaneName, number>;
  offset: Record<PaneName, number>;
  diff: string[];
  diffOffset: number;
  note: string;
  pulse: PulseState;
}

export function createState(repo: Repo): State {
  const state: State = {
    repo,
    github: githubRemote(repo.root),
    screen: "repo",
    pane: "files",
    selected: { files: 0, branches: 0, log: 0 },
    offset: { files: 0, branches: 0, log: 0 },
    diff: [],
    diffOffset: 0,
    note: "",
    pulse: createPulseState(),
  };
  refreshDiff(state);
  return state;
}

export function selectedFile(state: State): FileChange | undefined {
  return state.repo.files[state.selected.files];
}

/** The diff pane follows whichever pane has focus. */
export function refreshDiff(state: State): void {
  state.diffOffset = 0;
  if (state.pane === "files") {
    const file = selectedFile(state);
    state.diff = file
      ? fileDiff(state.repo.root, file, file.staged && !file.unstaged).split("\n")
      : [];
    return;
  }
  if (state.pane === "log") {
    const commit = state.repo.commits[state.selected.log];
    state.diff = commit
      ? (git(state.repo.root, ["show", "--no-color", "--stat", "--patch", commit.hash]) ?? "").split("\n")
      : [];
    return;
  }
  state.diff = [];
}

const statusGlyph = (file: FileChange): string => {
  if (file.conflicted) return "!!";
  if (file.untracked) return "??";
  return `${file.index === "." ? " " : file.index}${file.work === "." ? " " : file.work}`;
};

const statusColor = (theme: Theme, file: FileChange): number => {
  if (file.conflicted) return theme.danger;
  if (file.untracked) return theme.muted;
  if (file.staged && !file.unstaged) return theme.success;
  if (file.staged) return theme.warning;
  return theme.accent;
};

const PANES: PaneName[] = ["files", "branches", "log"];

function count(state: State, pane: PaneName): number {
  if (pane === "files") return state.repo.files.length;
  if (pane === "branches") return state.repo.branches.length;
  return state.repo.commits.length;
}

export function move(state: State, delta: number): void {
  const total = count(state, state.pane);
  if (total === 0) return;
  const next = Math.max(0, Math.min(total - 1, state.selected[state.pane] + delta));
  if (next === state.selected[state.pane]) return;
  state.selected[state.pane] = next;
  refreshDiff(state);
}

export function toggleStaged(state: State): void {
  const file = selectedFile(state);
  if (!file) return;
  const ok = file.staged && !file.unstaged
    ? unstage(state.repo.root, file)
    : stage(state.repo.root, file);
  state.note = ok ? "" : `could not ${file.staged ? "unstage" : "stage"} ${file.path}`;
  reload(state);
}

export function reload(state: State): void {
  const fresh = readRepo(state.repo.root);
  if (!fresh) { state.note = "repository disappeared"; return; }
  state.repo = fresh;
  for (const pane of PANES) {
    state.selected[pane] = Math.max(0, Math.min(count(state, pane) - 1, state.selected[pane]));
  }
  refreshDiff(state);
}

// ---------------------------------------------------------------- pulse

/** Read the git half of the pulse for the current range, and the traffic if a gh-pulse report has this repository. */
export function refreshPulse(state: State, now: Date = new Date()): void {
  const p = state.pulse;
  p.data = readPulse(state.repo.root, p.range, now);
  p.filesOffset = 0;
  p.traffic = state.github ? readTraffic(repoName(state.github)) : null;
}

/** Flip to the Pulse screen, reading it the first time or when the range changed. */
export function openPulse(state: State, range?: RangeKey, now: Date = new Date()): void {
  state.screen = "pulse";
  if (range) state.pulse.range = range;
  if (!state.pulse.data || state.pulse.data.range !== state.pulse.range) refreshPulse(state, now);
}

export function pickRange(state: State, range: RangeKey, now: Date = new Date()): void {
  state.pulse.range = range;
  state.pulse.note = "";
  refreshPulse(state, now);
}

export function scrollPulseFiles(state: State, delta: number): void {
  state.pulse.filesOffset = clampOffset(state.pulse.filesOffset + delta, state.pulse.data?.files.length ?? 0);
}

/**
 * The GitHub half, off the render loop. Every call takes a ticket; a reply for
 * an older ticket (the range changed while it was in flight) is dropped.
 */
export function startGitHub(
  state: State,
  onChange: () => void,
  now: Date = new Date(),
  fetch: Fetch = ghFetch,
  installed: () => boolean = ghInstalled,
): Promise<void> {
  const p = state.pulse;
  const ticket = ++p.githubRequest;
  const unavailable = (why: string): Promise<void> => {
    p.githubStatus = "unavailable";
    p.githubNote = why;
    onChange();
    return Promise.resolve();
  };
  if (!state.github) return unavailable("origin is not a GitHub remote");
  if (!installed()) return unavailable("gh is not installed");
  p.githubStatus = "loading";
  p.githubNote = "";
  onChange();
  return readGitHubPulse(state.github, sinceFor(p.range, now), fetch).then(
    (github) => {
      if (ticket !== p.githubRequest) return;
      p.github = github;
      p.githubStatus = "ready";
      onChange();
    },
    (error: unknown) => {
      if (ticket !== p.githubRequest) return;
      p.githubStatus = "unavailable";
      p.githubNote = error instanceof Error ? error.message : String(error);
      onChange();
    },
  );
}

// ---------------------------------------------------------------- command line

export const USAGE = `Usage:
  g1tz [path]                      the repository (default: the working directory)
  g1tz pulse [path] [--range KEY]  start on the Pulse screen
  KEY: ${RANGE_KEYS.join(", ")} (default week)`;

export interface Cli {
  path: string;
  pulse: boolean;
  range?: RangeKey;
  help: boolean;
  error?: string;
}

export function parseCli(argv: readonly string[]): Cli {
  const cli: Cli = { path: ".", pulse: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-h" || a === "--help") cli.help = true;
    else if (a === "pulse") cli.pulse = true;
    else if (a === "--range" || a.startsWith("--range=")) {
      const text = a === "--range" ? (argv[++i] ?? "") : a.slice("--range=".length);
      const key = parseRangeKey(text);
      if (!key) {
        cli.error = `--range wants one of ${RANGE_KEYS.join(", ")}, not "${text}"`;
        return cli;
      }
      cli.range = key;
      cli.pulse = true;
    } else if (a.startsWith("-")) {
      cli.error = `unknown option: ${a}`;
      return cli;
    } else cli.path = a;
  }
  return cli;
}

export async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  if (cli.error) {
    console.error(`g1tz: ${cli.error}\n${USAGE}`);
    process.exit(2);
  }
  const root = resolve(cli.path);
  const repo = readRepo(root);
  if (!repo) {
    console.error(`g1tz: ${root} is not a git repository.\nRun it inside one, or name one: g1tz ~/proj  (g1tz pulse ~/proj for the Pulse screen)`);
    process.exit(1);
  }
  const state = createState(repo);
  if (cli.pulse) openPulse(state, cli.range);
  // focusNavigation off: the app handles every key itself, and with it on,
  // Enter or Space would activate whichever range button held hqtui's hidden
  // focus (the first one) and silently switch the range to "day".
  const app = await createApp({ theme: themes.dark, title: "g1tz", quitKeys: ["ctrl+c"], focusNavigation: false });
  const changed = (): void => app.invalidate();
  const actions: PulseActions = {
    pickRange: (key) => { pickRange(state, key); void startGitHub(state, changed); changed(); },
    // The re-read panels and the spinner are the acknowledgement; a sticky note here would mask the GitHub line.
    refresh: () => { refreshPulse(state); void startGitHub(state, changed); changed(); },
    back: () => { state.screen = "repo"; changed(); },
    pulse: () => { openPulse(state); void startGitHub(state, changed); changed(); },
  };
  if (cli.pulse) void startGitHub(state, changed);

  // No `q` here: on this screen q is the quarter range. Ctrl+C quits from
  // anywhere, and p or Escape go back to the repository, where q quits.
  const pulseKey = (key: string): void => {
    switch (key) {
      case "p": case "escape": actions.back(); return;
      case "r": actions.refresh(); return;
      case "up": scrollPulseFiles(state, -1); return;
      case "down": scrollPulseFiles(state, 1); return;
      case "pageup": scrollPulseFiles(state, -10); return;
      case "pagedown": scrollPulseFiles(state, 10); return;
      default: {
        const range = rangeForHotkey(key);
        if (range) actions.pickRange(range);
      }
    }
  };

  app.on("key", (event: KeyEvent) => {
    if (state.screen === "pulse") {
      pulseKey(event.key);
      return;
    }
    switch (event.key) {
      case "q": app.quit(); return;
      case "tab":
        state.pane = PANES[(PANES.indexOf(state.pane) + 1) % PANES.length] as PaneName;
        refreshDiff(state);
        return;
      case "up": move(state, -1); return;
      case "down": move(state, 1); return;
      case "pageup": move(state, -10); return;
      case "pagedown": move(state, 10); return;
      case "space": toggleStaged(state); return;
      case "r": reload(state); state.note = "reloaded"; return;
      case "left": state.diffOffset = Math.max(0, state.diffOffset - 10); return;
      case "right": state.diffOffset += 10; return;
      case "p": actions.pulse(); return;
    }
  });

  app.render((args) => view(args, state, actions));
  await app.start();
}


/** Diff colours from the active theme, so highlighting follows the theme. */
export function diffPalette(theme: Theme): DiffPalette {
  return {
    add: theme.success,
    remove: theme.danger,
    hunk: theme.accent,
    meta: theme.muted,
    context: theme.foreground,
    // A background wash rather than another foreground: the line already
    // carries its add/remove colour, and a second one would compete with it.
    // `elevate` lifts the surface a little so the wash reads on both a light
    // and a dark palette.
    addEmphasis: elevate(theme, 0.18),
    removeEmphasis: elevate(theme, 0.18),
  };
}

export interface ViewArgs {
  ui: Container;
  theme: Theme;
  width: number;
  height: number;
  elapsed: number;
}

/** One frame: whichever screen the state is on. */
export function view(args: ViewArgs, state: State, actions: PulseActions = NO_ACTIONS): void {
  if (state.screen === "pulse") {
    pulseView(args, state.pulse, state.repo.root, actions);
    return;
  }
  repoView(args, state, actions);
}

function repoView({ ui, theme, height }: ViewArgs, state: State, actions: PulseActions): void {
  const repo = state.repo;
  const track = repo.upstream
    ? `${repo.upstream}${repo.ahead ? ` ↑${repo.ahead}` : ""}${repo.behind ? ` ↓${repo.behind}` : ""}`
    : "no upstream";

  ui.row({ size: 1 }, (header) => {
    header.text(" g1tz", { fg: theme.title, bold: true, size: 7 });
    header.text(repo.branch || "(detached)", { fg: theme.accent, size: 24 });
    header.text(track, { fg: theme.muted });
    header.text(`${repo.root}  Tab panes  Space stage  p pulse  q quit `, { fg: theme.muted, align: "right" });
  });

  ui.row({ size: height - 2, gap: 1 }, (row) => {
    row.column({ width: "1fr", gap: 1 }, (left) => {
      left.panel({
        title: `Files (${repo.files.length})`,
        size: "1.2fr",
        borderColor: state.pane === "files" ? theme.borderFocused : theme.border,
      }, (p) => {
        if (repo.files.length === 0) { p.label("Working tree clean."); return; }
        p.table({
          rows: repo.files.map((f) => ({
            st: statusGlyph(f),
            path: f.from ? `${f.from} → ${f.path}` : f.path,
            file: f,
          })),
          selected: state.selected.files,
          offset: state.offset.files,
          followSelection: true,
          scrollbar: true,
          onScroll: (d) => { state.offset.files = Math.max(0, state.offset.files + d); },
          header: false,
          columns: [
            // Per row, not per column: staged, unstaged and conflicted files
            // each need their own colour, and a column-wide colour would paint
            // the whole list whatever the first file happened to be.
            { key: "st", title: "", width: 3, color: (row) => statusColor(theme, row.file) },
            { key: "path", title: "", min: 8, color: theme.foreground },
          ],
        });
      });

      left.panel({
        title: `Branches (${repo.branches.length})`,
        size: "0.8fr",
        borderColor: state.pane === "branches" ? theme.borderFocused : theme.border,
      }, (p) => {
        if (repo.branches.length === 0) { p.label("No branches."); return; }
        p.list({
          items: repo.branches.map((b) =>
            `${b.current ? "* " : "  "}${b.name}${b.ahead ? ` ↑${b.ahead}` : ""}${b.behind ? ` ↓${b.behind}` : ""}`),
          selected: state.selected.branches,
          offset: state.offset.branches,
          scrollbar: true,
          onScroll: (d) => { state.offset.branches = Math.max(0, state.offset.branches + d); },
        });
      });

      left.panel({
        title: `Log (${repo.commits.length})`,
        size: "1fr",
        borderColor: state.pane === "log" ? theme.borderFocused : theme.border,
      }, (p) => {
        if (repo.commits.length === 0) { p.label("No commits."); return; }
        p.table({
          rows: repo.commits.map((c) => ({ hash: c.short, subject: c.subject, when: c.when })),
          selected: state.selected.log,
          offset: state.offset.log,
          followSelection: true,
          scrollbar: true,
          onScroll: (d) => { state.offset.log = Math.max(0, state.offset.log + d); },
          header: false,
          columns: [
            { key: "hash", title: "", width: 9, color: theme.warning },
            { key: "subject", title: "", min: 8, color: theme.foreground },
            { key: "when", title: "", width: 14, align: "right", color: theme.muted },
          ],
        });
      });
    });

    row.panel({ title: "Diff", width: "1.6fr" }, (p) => {
      if (state.note !== "") p.text(state.note, { fg: theme.warning, size: 1 });
      if (state.diff.length === 0 || (state.diff.length === 1 && state.diff[0] === "")) {
        p.label(state.pane === "branches" ? "Select a file or a commit." : "No changes.");
        return;
      }
      // Spans, so the words that actually differ can be emphasised inside an
      // otherwise green or red line. Highlighting runs over the whole diff
      // rather than the visible slice, because pairing a removal with its
      // addition needs to see both even when one is scrolled off.
      const highlighted = highlightDiff(state.diff, diffPalette(theme));
      for (const line of highlighted.slice(state.diffOffset, state.diffOffset + 400)) {
        p.text(line.length === 0 ? " " : line, { size: 1 });
      }
    });
  });

  ui.statusBar({
    items: [
      { key: "Tab", label: state.pane, active: true },
      { key: "Space", label: "Stage" },
      { key: "↑↓", label: "Move" },
      { key: "r", label: "Reload" },
      { key: "p", label: "Pulse", onPress: actions.pulse },
      { key: "q", label: "Quit" },
    ],
    right: [{ label: repo.errors.length ? `${repo.errors.length} git errors` : "" }],
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
