import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrFullContext,
  decodePrFullFile,
} from "../src/features/pulls/pr-full-context.ts";

const HEADER =
  "diff --git a/blob-old b/blob-new\n--- a/blob-old\n+++ b/blob-new\n";
const input = (overrides = {}) => ({
  path: "file.txt",
  oldPath: "file.txt",
  newPath: "file.txt",
  before: "top\nold\nbottom\n",
  after: "top\nnew\nbottom\n",
  patch: `${HEADER}@@ -2 +2 @@\n-old\n+new\n`,
  ...overrides,
});
const result = (overrides = {}) => buildPrFullContext(input(overrides));
const unavailable = (value) => assert.equal(value.kind, "unavailable");

test("expands both actual files and normalizes blob headers to real paths", () => {
  const full = result();
  assert.equal(full.kind, "ready");
  assert.equal(full.data.filePath, "file.txt");
  assert.equal(
    full.data.text,
    "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n" +
      "@@ -1,3 +1,3 @@\n top\n-old\n+new\n bottom\n",
  );
  assert.equal(full.data.isTruncated, false);
});

test("fills a verified unchanged gap between multiple hunks", () => {
  const full = result({
    before: "top\nold-a\nmiddle\nold-b\nbottom\n",
    after: "top\nnew-a\nmiddle\nnew-b\nbottom\n",
    patch: `${HEADER}@@ -2 +2 @@\n-old-a\n+new-a\n@@ -4 +4 @@\n-old-b\n+new-b\n`,
  });
  assert.equal(full.kind, "ready");
  assert.match(
    full.data.text,
    / top\n-old-a\n\+new-a\n middle\n-old-b\n\+new-b\n bottom\n$/,
  );
});

test("rejects a missing deletion even when the supplied hunk is self-consistent", () => {
  unavailable(
    result({
      before: "top\nomitted deletion\nold\nbottom\n",
      patch: `${HEADER}@@ -3 +2 @@\n-old\n+new\n`,
    }),
  );
});

test("rejects an omitted new-side tail", () => {
  unavailable(result({ after: "top\nnew\nbottom\nmissing addition\n" }));
});

test("rejects an omitted old-side tail", () => {
  unavailable(result({ before: "top\nold\nbottom\nmissing deletion\n" }));
});

for (const [name, patch] of [
  ["wrong old text", `${HEADER}@@ -2 +2 @@\n-stale\n+new\n`],
  ["wrong new text", `${HEADER}@@ -2 +2 @@\n-old\n+stale\n`],
  ["wrong context", `${HEADER}@@ -1,2 +1,2 @@\n stale\n-old\n+new\n`],
  ["wrong hunk counts", `${HEADER}@@ -2,2 +2,2 @@\n-old\n+new\n`],
  [
    "overlapping hunks",
    `${HEADER}@@ -2 +2 @@\n-old\n+new\n@@ -2 +2 @@\n-old\n+new\n`,
  ],
  ["out-of-range coordinates", `${HEADER}@@ -999 +999 @@\n-old\n+new\n`],
  ["invalid zero start", `${HEADER}@@ -0 +0 @@\n-old\n+new\n`],
  ["truncated record", `${HEADER}@@ -2 +2 @@\n-old\n+ne\n`],
  [
    "foreign section",
    `${HEADER}@@ -2 +2 @@\n-old\n+new\ndiff --git a/other b/other\n`,
  ],
]) {
  test(`rejects ${name}`, () => unavailable(result({ patch })));
}

test("renders a complete addition with an absent before side", () => {
  const full = result({
    oldPath: null,
    before: null,
    after: "one\ntwo\n",
    patch: null,
  });
  assert.equal(full.kind, "ready");
  assert.match(
    full.data.text,
    /--- \/dev\/null\n\+\+\+ b\/file.txt\n@@ -0,0 \+1,2 @@\n\+one\n\+two\n$/,
  );
});

test("renders a complete deletion from the real before side", () => {
  const full = result({
    newPath: null,
    after: null,
    before: "one\ntwo\n",
    patch: null,
  });
  assert.equal(full.kind, "ready");
  assert.match(
    full.data.text,
    /--- a\/file.txt\n\+\+\+ \/dev\/null\n@@ -1,2 \+0,0 @@\n-one\n-two\n$/,
  );
});

test("an empty native patch expands only identical actual texts, including a rename", () => {
  const full = result({
    oldPath: "old.txt",
    before: "same\n",
    after: "same\n",
    patch: "",
  });
  assert.equal(full.kind, "ready");
  assert.equal(full.data.oldPath, "old.txt");
  assert.match(
    full.data.text,
    /--- a\/old.txt\n\+\+\+ b\/file.txt\n@@ -1,1 \+1,1 @@\n same\n$/,
  );
  unavailable(result({ patch: "" }));
  unavailable(result({ patch: null }));
});

test("preserves each side's missing final newline", () => {
  const full = result({
    before: "old",
    after: "new",
    patch: `${HEADER}@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n`,
  });
  assert.equal(full.kind, "ready");
  assert.match(
    full.data.text,
    /-old\n\\ No newline at end of file\n\+new\n\\ No newline at end of file\n$/,
  );
  unavailable(
    result({
      before: "top\nold",
      after: "top\nnew",
      patch: `${HEADER}@@ -2 +2 @@\n-old\n+new\n`,
    }),
  );
});

test("verifies a newline-only change without normalizing its bytes", () => {
  const full = result({
    before: "same\n",
    after: "same",
    patch: `${HEADER}@@ -1 +1 @@\n-same\n+same\n\\ No newline at end of file\n`,
  });
  assert.equal(full.kind, "ready");
  assert.match(
    full.data.text,
    /-same\n\+same\n\\ No newline at end of file\n$/,
  );
});

test("keeps BOM and CR characters in actual unchanged and changed lines", () => {
  const full = result({
    before: "\uFEFFtop\r\nold\r\nbottom\r\n",
    after: "\uFEFFtop\r\nnew\r\nbottom\r\n",
    patch: `${HEADER}@@ -2 +2 @@\n-old\r\n+new\r\n`,
  });
  assert.equal(full.kind, "ready");
  assert.match(full.data.text, / \uFEFFtop\r\n-old\r\n\+new\r\n bottom\r\n$/);
});

test("refuses mismatched path/absence metadata and distinguishes empty versions", () => {
  unavailable(result({ oldPath: null }));
  unavailable(result({ newPath: "another.txt" }));
  assert.equal(result({ before: "", after: "", patch: "" }).kind, "empty");
});

test("caps emitted rows, including removed and added lines", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old-${i}\n`).join("");
  const after = Array.from({ length: 3000 }, (_, i) => `new-${i}\n`).join("");
  const patch = `${HEADER}@@ -1,3000 +1,3000 @@\n${before
    .split("\n")
    .slice(0, -1)
    .map((line) => `-${line}\n`)
    .join("")}${after
    .split("\n")
    .slice(0, -1)
    .map((line) => `+${line}\n`)
    .join("")}`;
  const full = result({ before, after, patch });
  unavailable(full);
  assert.equal(full.reason, "too-large");
});

test("refuses oversized text and lines that the renderer would shorten", () => {
  for (const text of ["x".repeat(400_001), "x".repeat(4000)]) {
    const full = result({ before: text, after: text, patch: "" });
    unavailable(full);
    assert.equal(full.reason, "too-large");
  }
});

const bytes = (text) => ({
  base64: Buffer.from(text).toString("base64"),
  mime: null,
  tooLarge: false,
  size: Buffer.byteLength(text),
});
test("strict byte decoding preserves the UTF-8 BOM and CRLF", () => {
  assert.deepEqual(decodePrFullFile(bytes("\uFEFFa\r\n")), {
    kind: "text",
    text: "\uFEFFa\r\n",
  });
  assert.deepEqual(decodePrFullFile(null), { kind: "text", text: null });
  assert.deepEqual(decodePrFullFile(bytes("")), { kind: "text", text: "" });
});
test("byte decoding refuses NUL, invalid UTF-8, and withheld oversize payloads", () => {
  for (const data of [
    bytes("a\0b"),
    { ...bytes(""), base64: "/w==" },
    { ...bytes(""), tooLarge: true, base64: null },
  ])
    unavailable(decodePrFullFile(data));
});
