import assert from "node:assert/strict";
import test from "node:test";
import { literalSearchPattern } from "../src/features/diff/text-search.ts";
import { searchPrDiffs } from "../src/features/pulls/pr-diff-search.ts";

test("literal matching preserves punctuation and Unicode source offsets", () => {
  assert.equal(literalSearchPattern(""), null);
  assert.equal(literalSearchPattern(".*+").exec("before .*+ after")?.index, 7);
  assert.equal(literalSearchPattern("k").exec("😀K")?.index, 2);
  assert.equal(literalSearchPattern("needle", true).test("NEEDLE"), false);
  assert.equal(literalSearchPattern("needle").test("NEEDLE"), true);
});

test("MR search preserves both sides' line numbers, hunk resets and CRLF", () => {
  const sections = new Map([
    [
      "renamed.ts",
      [
        "diff --git a/needle.ts b/renamed.ts",
        "--- a/needle.ts",
        "+++ b/renamed.ts",
        "@@ -10,2 +20,2 @@ needle in a hunk header",
        "-old needle",
        "+new needle",
        " same needle",
        "@@ -100 +200 @@",
        "-needle again",
        "+replacement",
        "\\ No newline at end of file",
      ].join("\r\n"),
    ],
  ]);
  const result = searchPrDiffs(sections, "needle");
  assert.equal(result.total, 4);
  assert.equal(result.files, 1);
  assert.deepEqual(
    result.matches.map(({ side, line, column }) => ({ side, line, column })),
    [
      { side: "old", line: 10, column: 5 },
      { side: "new", line: 20, column: 5 },
      { side: "new", line: 21, column: 6 },
      { side: "old", line: 100, column: 1 },
    ],
  );
});

test("added and deleted files search their existing side; binary and header-only sections do not match", () => {
  const result = searchPrDiffs(
    new Map([
      ["deleted.txt", "@@ -1,2 +0,0 @@\n-needle\n-another needle\n"],
      ["added.txt", "@@ -0,0 +1,2 @@\n+needle\n+another needle\n"],
      ["binary", "Binary files a/needle and b/needle differ\n"],
      [
        "needle.txt",
        "diff --git a/needle.txt b/needle.txt\nold mode 100644\nnew mode 100755\n",
      ],
    ]),
    "needle",
  );
  assert.equal(result.total, 4);
  assert.equal(result.files, 2);
  assert.deepEqual(
    result.matches.map(({ side, line }) => [side, line]),
    [
      ["old", 1],
      ["old", 2],
      ["new", 1],
      ["new", 2],
    ],
  );
});

test("MR search counts all matches while bounding the displayed result list", () => {
  const patch = `@@ -0,0 +1,601 @@\n${Array.from({ length: 601 }, () => "+needle").join("\n")}`;
  const result = searchPrDiffs(new Map([["many.txt", patch]]), "needle");
  assert.equal(result.total, 601);
  assert.equal(result.matches.length, 500);
  assert.equal(result.matches.at(-1).line, 500);
  assert.equal(searchPrDiffs(new Map([["many.txt", patch]]), "").total, 0);
});
