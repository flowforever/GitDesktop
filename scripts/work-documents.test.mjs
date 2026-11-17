import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());
const { documentId, openDocument, closeDocument } = await import(
  "@/lib/stores/work-documents"
);
const { filterMyWork } = await import("@/features/mywork/mywork-utils");
const doc = (host, project, number = 7) => ({
  host,
  repoFullName: project,
  number,
  title: "Review",
  repoPath: "/repos/repo",
  repoName: "repo",
});

test("MR filters accept the displayed exclamation-mark number without matching issues", () => {
  const mr = {
    title: "Review",
    repoFullName: "team/repo",
    number: 7,
    isPullRequest: true,
  };
  const issue = { ...mr, title: "Bug", isPullRequest: false };
  assert.deepEqual(filterMyWork([mr, issue], "all", "!7"), [mr]);
});

test("one MR is reused across lists and local checkouts without conflating hosts or nested groups", () => {
  let state = { documents: [], activeId: null };
  state = openDocument(state, doc("git.one.test", "a/sub/repo"));
  state = openDocument(state, {
    ...doc("git.one.test", "a/sub/repo"),
    repoPath: "/worktrees/repo",
  });
  assert.equal(state.documents.length, 1);
  state = openDocument(state, doc("git.two.test", "a/sub/repo"));
  state = openDocument(state, doc("git.one.test", "b/sub/repo"));
  assert.equal(state.documents.length, 3);
});

test("closing the active MR selects a neighbor, then home; closing a background MR preserves selection", () => {
  let state = { documents: [], activeId: null };
  const a = doc("git.test", "team/a");
  const b = doc("git.test", "team/b");
  state = openDocument(openDocument(state, a), b);
  state = closeDocument(state, documentId(a));
  assert.equal(state.activeId, documentId(b));
  state = closeDocument(state, documentId(b));
  assert.deepEqual(state, { documents: [], activeId: null });
});
