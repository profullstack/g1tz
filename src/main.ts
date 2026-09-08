/**
 * g1tz — a git TUI that shows you the repository, not a menu of git commands.
 *
 *   bunx g1tz          # the repository in the working directory
 *   bunx g1tz ~/proj   # somewhere else
 *
 * Files, branches and log on the left; the diff for whatever is selected on
 * the right. Space stages and unstages.
 */
import { createApp, themes, type Container, type KeyEvent, type Theme } from "@profullstack/hqtui";
import { resolve } from "node:path";
import {
  diffLineKind, fileDiff, git, readRepo, stage, unstage,
  type FileChange, type Repo,
} from "./git.ts";

export type PaneName = "files" | "branches" | "log";

export interface State {
  repo: Repo;
  pane: PaneName;
  selected: Record<PaneName, number>;
  offset: Record<PaneName, number>;
  diff: string[];
  diffOffset: number;
  note: string;
}

export function createState(repo: Repo): State {
  const state: State = {
    repo,
    pane: "files",
    selected: { files: 0, branches: 0, log: 0 },
    offset: { files: 0, branches: 0, log: 0 },
    diff: [],
    diffOffset: 0,
    note: "",
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

async function main(): Promise<void> {
  const repo = readRepo(resolve(process.argv[2] ?? "."));
  if (!repo) {
    console.error("g1tz: not a git repository");
    process.exit(1);
  }
  const state = createState(repo);
  const app = await createApp({ theme: themes.dark, title: "g1tz", quitKeys: ["ctrl+c"] });

  app.on("key", (event: KeyEvent) => {
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
    }
  });

  app.render((args) => view(args, state));
  await app.start();
}

export function view(
  { ui, theme, height }: { ui: Container; theme: Theme; height: number },
  state: State,
): void {
  const repo = state.repo;
  const track = repo.upstream
    ? `${repo.upstream}${repo.ahead ? ` ↑${repo.ahead}` : ""}${repo.behind ? ` ↓${repo.behind}` : ""}`
    : "no upstream";

  ui.row({ size: 1 }, (header) => {
    header.text(" g1tz", { fg: theme.title, bold: true, size: 7 });
    header.text(repo.branch || "(detached)", { fg: theme.accent, size: 24 });
    header.text(track, { fg: theme.muted });
    header.text(`${repo.root}  Tab panes  Space stage  q quit `, { fg: theme.muted, align: "right" });
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
      // One text() per line so each can take the colour its prefix implies.
      // A single styled call would be better; that wants hqtui#60.
      for (const line of state.diff.slice(state.diffOffset, state.diffOffset + 400)) {
        p.text(line, { fg: theme[diffLineKind(line)], size: 1 });
      }
    });
  });

  ui.statusBar({
    items: [
      { key: "Tab", label: state.pane, active: true },
      { key: "Space", label: "Stage" },
      { key: "↑↓", label: "Move" },
      { key: "r", label: "Reload" },
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
