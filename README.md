# g1tz

A git TUI that shows you the repository, not a menu of git commands.

```
bunx g1tz          # the repository you are standing in
bunx g1tz ~/proj   # somewhere else
```

```
 g1tz  main                    origin/main ↓1                        ~/hqtui  Tab panes  Space stage  q quit
╭─ Files (3) ───────────────────────────╮ ╭─ Diff ─────────────────────────────────────────────────────────╮
│ M    src/a.ts                         │ │ @@ -0,0 +1,8 @@                                                │
│  M   src/b.ts                         │ │ +export interface Span {                                       │
│ ??   new.ts                           │ │ +  text: string;                                               │
╰───────────────────────────────────────╯ │ +}                                                             │
╭─ Branches (39) ───────────────────────╮ │  const style: Style = { fg: options.fg };                      │
│ * main ↓1                             │ │                                                                │
│   spans-richtext                      │ │                                                                │
╰───────────────────────────────────────╯ │                                                                │
╭─ Log (78) ────────────────────────────╮ │                                                                │
│ e28fec7   Finish widget parity  2h   │ │                                                                 │
╰───────────────────────────────────────╯ ╰────────────────────────────────────────────────────────────────╯
 Tab files  Space Stage  ↑↓ Move  r Reload  q Quit
```

Files, branches and log down the left. The diff on the right follows whatever you have selected — a file's changes, or a commit's patch.

## Keys

| Key | Does |
|---|---|
| `Tab` | Cycle files → branches → log |
| `↑` `↓` `PgUp` `PgDn` | Move the selection |
| `Space` | Stage the selected file, or unstage it if it is fully staged |
| `←` `→` | Scroll the diff |
| `r` | Re-read the repository |
| `q` | Quit |

## How it reads git

By shelling out, using porcelain formats only, with `-z` wherever a path could contain a newline. Parsing output meant for humans is how a TUI ends up corrupting someone's working tree.

`git` runs with `GIT_PAGER=cat`, `GIT_EDITOR=true` and `GIT_OPTIONAL_LOCKS=0`, so nothing it invokes can take the terminal away from the interface or fight the editor you already have open.

Untracked files are listed with `--untracked-files=all`. The default collapses a new directory to a single `? sub/` entry, and you cannot stage or diff a directory.

## Status

Early, and deliberately read-mostly. It reads the repository and stages files. It does **not** yet commit, push, pull, branch, rebase, stash, or discard — the destructive half is the half worth getting right slowly.

Known rough edges:

- The diff is coloured a line at a time, one `text()` call per line, because per-line styling is all the library offers today. Styled spans land in `@profullstack/hqtui` 0.3.0 ([hqtui#60](https://github.com/profullstack/hqtui/issues/60)) and will make word-level diff highlighting possible.
- No hunk staging. That wants an interactive diff pane.

## Built with

[hqtui](https://hqtui.com) — the terminal UI library. g1tz exists partly to keep hqtui honest: a real application finds the gaps a widget gallery does not.

## Licence

MIT
