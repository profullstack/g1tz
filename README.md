<p align="center">
  <img src="https://raw.githubusercontent.com/profullstack/g1tz/main/logo.svg" alt="g1tz — a Git client for your terminal" width="720">
</p>

# g1tz

A git TUI that shows you the repository, not a menu of git commands.

## Quick start

Run g1tz inside an existing Git repository, or pass the path to one:

```sh
cd /path/to/your/repository
bunx @profullstack/g1tz

# Or open a repository from any directory:
bunx @profullstack/g1tz /path/to/your/repository

# Optional global install:
npm i -g @profullstack/g1tz
g1tz /path/to/your/repository
```

A `not a git repository` message means the current directory (or the path you passed) is not inside a Git repository. For example, running the bare command from `~` will fail unless your home directory is itself a Git repository. Pass a project path instead.

The package is scoped because npm refuses the bare name ("too similar to got, gts"); the command it installs is still `g1tz`.

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
| `p` | Pulse: what moved over a period (below) |
| `q` | Quit |

## Pulse

`p` flips to Pulse: what moved in this repository over a period, the way GitHub's Insights > Pulse tab shows it, but for the repository you are standing in and without leaving the terminal.

```
bunx @profullstack/g1tz pulse                 # start on the Pulse screen, last week
bunx @profullstack/g1tz pulse --range month   # day, week, month, quarter, year, all
```

Three sources, each optional beyond the first:

- **git**, always, offline: commits and authors on the branch and across every branch (merges counted separately, as GitHub does), the net change to the tree since the period began (`git diff` from the first parent of the oldest commit in range, with `-M` so a rename is a rename), commits per hour, day, week or month, the branches that saw commits and the tags that were created.
- **GitHub**, when `origin` is on github.com and `gh` is logged in: pull requests opened, merged and closed, issues opened and closed, releases, and new stars for the period. Pages are walked newest first under a small budget; when the budget runs out the counts are floors and the status bar says so. Nothing here sees a token; `gh` holds the login.
- **Traffic**, when a [gh-pulse](https://github.com/profullstack/cli-tools) report exists on the machine (`~/.local/share/gh-pulse`, or `GH_PULSE_DATA`): views and clones for the last fourteen days, referrers and popular paths. GitHub only serves those through its traffic API and only for fourteen days; gh-pulse keeps them.

| Key | Does |
|---|---|
| `d` `w` `m` `q` `y` `a` | Pick the range: day, week, month, quarter, year, all time. The range buttons are clickable too. |
| `↑` `↓` `PgUp` `PgDn` | Scroll the files |
| `r` | Read it again |
| `p` `Esc` | Back to the repository, where `q` quits |
| `Ctrl+C` | Quit |

## Teams

`t` flips to the Team screen: the organization this terminal signed in to, its members and their roles, teams, shared workspaces with their repositories, seats, and every feature with the plan that unlocks it. The roles are the ones a GitKraken team already knows: one Owner, then Admin, Lead, User and Billing Contact, and every role but Billing Contact holds a seat.

```sh
g1tz login                                   # a code, approved in the browser at g1tz.hqtui.com
g1tz org create Acme
g1tz members invite bo@acme.test --role admin
g1tz teams create Platform
g1tz workspaces create Everything
g1tz workspaces add WORKSPACE https://github.com/acme/site
g1tz plan                                    # what the plan unlocks, and what it does not
g1tz audit                                   # who changed what
```

Community is free for one seat and never gates anything local. Pro invites people and shares workspaces, Advanced adds teams and a verified email domain, Business adds Insights, the Lead role and audit export. A plan is an [OpenAccess](https://logicsrc.com/openaccess) entitlement, so it travels between apps. The whole model, the command line, the account page and how to run your own server are in [docs/teams.md](docs/teams.md).

| Key | Does |
|---|---|
| `Tab` | Cycle members → teams → workspaces |
| `↑` `↓` `PgUp` `PgDn` | Move the selection |
| `r` | Read the organization again (picks up a fresh `g1tz login`) |
| `t` `Esc` | Back to the repository |

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

Logo and favicon assets are available in [SVG](https://raw.githubusercontent.com/profullstack/g1tz/main/logo.svg) and [PNG](https://raw.githubusercontent.com/profullstack/g1tz/main/logo.png), with matching [SVG](https://raw.githubusercontent.com/profullstack/g1tz/main/favicon.svg) and [PNG](https://raw.githubusercontent.com/profullstack/g1tz/main/favicon.png) favicons. See [brand asset provenance](BRANDING.md) for generation prompts and vector details.
