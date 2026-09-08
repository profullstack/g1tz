/**
 * Diff rendering, as spans.
 *
 * A whole line coloured green tells you it changed. Colouring only the words
 * that actually differ tells you *what* changed, which is the thing you were
 * squinting at the line to work out.
 */
import type { SpanLine } from "@profullstack/hqtui";
import { diffLineKind } from "./git.ts";

export interface DiffPalette {
  add: number;
  remove: number;
  hunk: number;
  meta: number;
  context: number;
  /** Background emphasis for the words that actually differ. */
  addEmphasis: number;
  removeEmphasis: number;
}

/** Split into words and the separators between them, both kept. */
export function words(line: string): string[] {
  return line.split(/(\W)/).filter((part) => part !== "");
}

export interface Segment {
  text: string;
  changed: boolean;
}

/**
 * The differing middle of two lines, found by trimming the common prefix and
 * suffix. Not a full Myers diff: for the single-line case a prefix/suffix trim
 * is what people actually read, and it cannot produce the confetti that a
 * token-level LCS gives you on a reformatted line.
 */
export function intraLine(before: string, after: string): { before: Segment[]; after: Segment[] } {
  const a = words(before);
  const b = words(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const build = (parts: string[]): Segment[] => {
    const middle = parts.slice(head, parts.length - tail).join("");
    const out: Segment[] = [];
    const prefix = parts.slice(0, head).join("");
    const suffix = parts.slice(parts.length - tail).join("");
    if (prefix) out.push({ text: prefix, changed: false });
    if (middle) out.push({ text: middle, changed: true });
    if (suffix) out.push({ text: suffix, changed: false });
    return out;
  };

  return { before: build(a), after: build(b) };
}

/**
 * Pair each removed line with the added line that replaced it.
 *
 * Only runs of equal length are paired. An unequal run is a genuine insertion
 * or deletion rather than an edit, and pretending otherwise produces word
 * highlighting that points at the wrong thing.
 */
export function pairRuns(lines: string[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < lines.length) {
    if (!isRemoval(lines[i] as string)) { i++; continue; }
    let removals = 0;
    while (i + removals < lines.length && isRemoval(lines[i + removals] as string)) removals++;
    let additions = 0;
    while (
      i + removals + additions < lines.length &&
      isAddition(lines[i + removals + additions] as string)
    ) additions++;
    if (removals === additions && removals > 0) {
      for (let k = 0; k < removals; k++) pairs.set(i + k, i + removals + k);
    }
    i += removals + additions;
  }
  return pairs;
}

function isRemoval(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

function isAddition(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

/** A whole diff as span lines, with the changed words emphasised. */
export function highlightDiff(lines: string[], palette: DiffPalette): SpanLine[] {
  const pairs = pairRuns(lines);
  const partnerOf = new Map<number, number>();
  for (const [from, to] of pairs) partnerOf.set(to, from);

  const colorFor = (line: string): number => {
    switch (diffLineKind(line)) {
      case "success": return palette.add;
      case "danger": return palette.remove;
      case "accent": return palette.hunk;
      case "muted": return palette.meta;
      default: return palette.context;
    }
  };

  return lines.map((line, index) => {
    const base = colorFor(line);

    const partner = pairs.has(index)
      ? (lines[pairs.get(index) as number] as string)
      : partnerOf.has(index)
        ? (lines[partnerOf.get(index) as number] as string)
        : undefined;

    if (partner === undefined) {
      return line === "" ? [] : [{ text: line, fg: base }];
    }

    const removed = isRemoval(line);
    const { before, after } = intraLine(
      (removed ? line : partner).slice(1),
      (removed ? partner : line).slice(1),
    );
    const segments = removed ? before : after;
    const emphasis = removed ? palette.removeEmphasis : palette.addEmphasis;

    return [
      { text: line.slice(0, 1), fg: base },
      ...segments.map((segment) => ({
        text: segment.text,
        fg: base,
        ...(segment.changed ? { bg: emphasis, bold: true } : {}),
      })),
    ];
  });
}
