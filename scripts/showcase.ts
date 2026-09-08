/**
 * Frames for the hqtui.com apps showcase.
 *
 * A fixture repository rather than whatever happens to be checked out, so the
 * screenshot is the same on every machine and every run.
 */
import { createState, view } from "../src/main.ts";
import type { Repo } from "../src/git.ts";

const REPO: Repo = {
  root: "~/hqtui",
  branch: "spans-richtext",
  upstream: "origin/spans-richtext",
  ahead: 2,
  behind: 0,
  files: [
    { index: "M", work: ".", path: "packages/hqtui/src/richtext.ts", staged: true, unstaged: false, untracked: false, conflicted: false },
    { index: "M", work: ".", path: "packages/hqtui/src/surface.ts", staged: true, unstaged: false, untracked: false, conflicted: false },
    { index: ".", work: "M", path: "packages/hqtui/src/widgets/text.ts", staged: false, unstaged: true, untracked: false, conflicted: false },
    { index: "?", work: "?", path: "packages/hqtui/test/richtext.test.ts", staged: false, unstaged: true, untracked: true, conflicted: false },
  ],
  commits: [
    { hash: "a".repeat(40), short: "43d0e3e", subject: "feat(text): styled spans", author: "Ann", when: "12 minutes ago", refs: "HEAD -> spans" },
    { hash: "b".repeat(40), short: "714b354", subject: "fix(demo): make [c] actually collapse", author: "Ann", when: "2 hours ago", refs: "" },
    { hash: "c".repeat(40), short: "e28fec7", subject: "Finish widget parity", author: "Bo", when: "yesterday", refs: "" },
    { hash: "d".repeat(40), short: "2343621", subject: "feat: COBOL is a demo language", author: "Bo", when: "yesterday", refs: "" },
  ],
  branches: [
    { name: "spans-richtext", current: true, upstream: "origin/spans-richtext", ahead: 2, behind: 0 },
    { name: "main", current: false, upstream: "origin/main", ahead: 0, behind: 1 },
    { name: "release-0-3-0", current: false, upstream: "", ahead: 0, behind: 0 },
  ],
  errors: [],
};

const DIFF = [
  "diff --git a/packages/hqtui/src/widgets/text.ts b/packages/hqtui/src/widgets/text.ts",
  "index 4a1c8e2..9f3b7d1 100644",
  "--- a/packages/hqtui/src/widgets/text.ts",
  "+++ b/packages/hqtui/src/widgets/text.ts",
  "@@ -24,9 +24,14 @@ function attrsOf(o: TextOptions): number {",
  " ",
  "-export function drawText(surface: Surface, content: string, options: TextOptions = {}): void {",
  "+export function drawText(surface: Surface, content: RichText, options: TextOptions = {}): void {",
  "   if (surface.empty) return;",
  "   const style: Style = {",
  "     fg: options.fg ?? surface.theme.foreground,",
  "   };",
  "-  const lines = content.split(\"\\n\");",
  "+  const lines = options.wrap ? wrapRich(content, surface.width) : toSpanLines(content);",
  "   for (let i = 0; i < lines.length && i < surface.height; i++) {",
  "-    surface.text(0, i, lines[i], style);",
  "+    surface.spans(0, i, fitSpans(lines[i], surface.width, options.align ?? \"left\"), style);",
  "   }",
  " }",
];

export const frames = [
  {
    name: "g1tz",
    width: 132,
    height: 34,
    draw: (args: { ui: unknown; theme: unknown; height: number }) => {
      const state = createState(REPO);
      state.diff = DIFF;
      state.selected.files = 2;
      view(args as never, state);
    },
  },
];
