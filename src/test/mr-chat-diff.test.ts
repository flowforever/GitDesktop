import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MrChatContext } from "@/features/pulls/mr-chat/context";
import { loadMrChatDiff } from "@/features/pulls/mr-chat/load-diff";
import { prDiffOptions } from "@/lib/git/queries/prs";

const backend = vi.hoisted(() => ({ view: vi.fn(), diff: vi.fn() }));
vi.mock("@/lib/git/api/prs", async (original) => ({
  ...(await original<typeof import("@/lib/git/api/prs")>()),
  forgePrView: backend.view,
  forgePrDiff: backend.diff,
}));
const head = "b".repeat(40);
const context: MrChatContext = {
  mr: { host: "git.example.com", repoFullName: "team/repo", number: 7 },
  repoPath: "/repo",
  url: "https://git.example.com/team/repo/-/merge_requests/7",
  title: "Change",
  body: "",
  baseRefName: "main",
  headRefName: "feature",
  headSha: head,
  files: [{ path: "file.ts" }],
};
const details = (sha = head) => ({
  ...context,
  number: 7,
  headSha: sha,
  commits: [],
  commitsUnknown: false,
  commitsTruncated: false,
});
const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(value);
  return value;
}
afterEach(() => {
  for (const entry of clients) entry.clear();
  clients.length = 0;
  vi.resetAllMocks();
});

describe("MR chat diff provenance", () => {
  it("ignores a previous head's populated UI cache", async () => {
    const cache = client();
    cache.setQueryData(
      prDiffOptions("/repo", 7, "origin").queryKey,
      "old-head-diff",
    );
    backend.view.mockResolvedValue(details());
    backend.diff.mockResolvedValue("new-head-diff");
    await expect(loadMrChatDiff(cache, context, "origin")).resolves.toBe(
      "new-head-diff",
    );
    expect(backend.diff).toHaveBeenCalledOnce();
  });
  it("refuses a head update while preparing the diff", async () => {
    backend.view
      .mockResolvedValueOnce(details())
      .mockResolvedValueOnce(details("c".repeat(40)));
    backend.diff.mockResolvedValue("diff-from-changing-head");
    await expect(loadMrChatDiff(client(), context, "origin")).rejects.toThrow(
      /changed|reload/i,
    );
  });
  it("refuses an outdated open MR before reading its diff", async () => {
    backend.view.mockResolvedValue(details("c".repeat(40)));
    backend.diff.mockResolvedValue("newer-diff");
    await expect(loadMrChatDiff(client(), context, "origin")).rejects.toThrow(
      /changed|reload/i,
    );
    expect(backend.diff).not.toHaveBeenCalled();
  });
  it("does not substitute a cached diff after a failed fresh read", async () => {
    const cache = client();
    cache.setQueryData(
      prDiffOptions("/repo", 7, "origin").queryKey,
      "old-head-diff",
    );
    backend.view.mockResolvedValue(details());
    backend.diff.mockRejectedValue(new Error("Diff temporarily unavailable"));
    await expect(loadMrChatDiff(cache, context, "origin")).rejects.toThrow(
      "Diff temporarily unavailable",
    );
  });
});
