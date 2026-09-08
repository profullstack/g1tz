import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightDiff, intraLine, pairRuns, words } from "../src/diff.ts";

const P = {
  add: 1, remove: 2, hunk: 3, meta: 4, context: 5,
  addEmphasis: 6, removeEmphasis: 7,
};

const textOf = (line: { text: string }[]) => line.map((s) => s.text).join("");

test("words keeps separators so a line can be rebuilt exactly", () => {
  const parts = words("const a = b(1);");
  assert.equal(parts.join(""), "const a = b(1);");
});

test("only the differing middle is marked changed", () => {
  const { before, after } = intraLine("const a = oldValue;", "const a = newValue;");
  assert.equal(before.map((s) => s.text).join(""), "const a = oldValue;");
  assert.equal(after.map((s) => s.text).join(""), "const a = newValue;");
  assert.deepEqual(before.filter((s) => s.changed).map((s) => s.text), ["oldValue"]);
  assert.deepEqual(after.filter((s) => s.changed).map((s) => s.text), ["newValue"]);
});

test("identical lines have nothing changed", () => {
  const { before, after } = intraLine("same", "same");
  assert.equal(before.filter((s) => s.changed).length, 0);
  assert.equal(after.filter((s) => s.changed).length, 0);
});

test("a pure insertion marks only the inserted part", () => {
  const { after } = intraLine("a c", "a b c");
  assert.equal(after.map((s) => s.text).join(""), "a b c");
  assert.ok(after.some((s) => s.changed && s.text.includes("b")));
});

test("equal-length runs pair up", () => {
  const pairs = pairRuns(["@@", "-one", "-two", "+uno", "+dos", " ctx"]);
  assert.equal(pairs.get(1), 3, "first removal pairs with first addition");
  assert.equal(pairs.get(2), 4);
});

test("an unequal run is left unpaired, because it is not an edit", () => {
  // Two removals and one addition is a deletion plus a change, not two edits.
  assert.equal(pairRuns(["-a", "-b", "+c"]).size, 0);
  // A pure addition has nothing to pair with.
  assert.equal(pairRuns(["+only"]).size, 0);
});

test("file headers are not mistaken for additions or removals", () => {
  assert.equal(pairRuns(["--- a/x", "+++ b/x"]).size, 0);
});

test("changed words are emphasised, unchanged ones are not", () => {
  const [removed, added] = highlightDiff(["-const a = old;", "+const a = new;"], P);
  assert.equal(textOf(removed!), "-const a = old;");
  assert.equal(textOf(added!), "+const a = new;");

  const emphasised = (line: typeof removed) =>
    line!.filter((s) => "bg" in s && s.bg !== undefined).map((s) => s.text);
  assert.deepEqual(emphasised(removed), ["old"]);
  assert.deepEqual(emphasised(added), ["new"]);

  // The marker keeps the line colour and is never emphasised.
  assert.equal(removed![0]?.text, "-");
  assert.equal(removed![0]?.fg, P.remove);
  assert.equal(added![0]?.fg, P.add);
});

test("unpaired lines render as one span in their line colour", () => {
  const out = highlightDiff(["@@ -1 +1 @@", " context", "+lonely"], P);
  assert.deepEqual(out[0], [{ text: "@@ -1 +1 @@", fg: P.hunk }]);
  assert.deepEqual(out[1], [{ text: " context", fg: P.context }]);
  assert.deepEqual(out[2], [{ text: "+lonely", fg: P.add }]);
});

test("every line's text survives highlighting unchanged", () => {
  const diff = [
    "diff --git a/x b/x",
    "index abc..def 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-const timeout = 30;",
    "+const timeout = 60;",
    " tail",
    "",
  ];
  assert.deepEqual(highlightDiff(diff, P).map(textOf), diff);
});

test("a blank line stays blank rather than becoming a space", () => {
  assert.deepEqual(highlightDiff([""], P)[0], []);
});
