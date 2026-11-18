import type { QueryClient } from "@tanstack/react-query";
import { forgePrDiff, forgePrView } from "@/lib/git/api/prs";
import { FULL_OID_RE } from "@/lib/git/oid";
import { type PrDetails, prHeadSha, type RemoteLens } from "@/lib/git/types";
import { type MrChatContext, mrChatKey, parseMrChatIdentity } from "./context";

type DiffTarget = Pick<
  MrChatContext,
  "mr" | "repoPath" | "headSha" | "baseRefName" | "headRefName"
>;

export function loadMrChatDiff(
  client: QueryClient,
  context: DiffTarget,
  lens: RemoteLens,
): Promise<string> {
  const expected = context.headSha;
  if (!expected || !FULL_OID_RE.test(expected))
    return Promise.reject(
      new Error("The MR head is unavailable. Reload the MR before sending."),
    );
  const verify = (details: PrDetails) => {
    const identity = parseMrChatIdentity(details.url, details.number);
    const head =
      details.headSha ||
      (!details.commitsUnknown && !details.commitsTruncated
        ? prHeadSha(details)
        : undefined);
    if (
      !identity ||
      mrChatKey(identity) !== mrChatKey(context.mr) ||
      head?.toLowerCase() !== expected.toLowerCase() ||
      details.baseRefName !== context.baseRefName ||
      details.headRefName !== context.headRefName
    )
      throw new Error(
        "This MR changed while preparing chat context. Reload the MR before sending again.",
      );
  };
  return client.fetchQuery({
    queryKey: [
      "repo",
      context.repoPath,
      "pr",
      lens,
      context.mr.number,
      "chat-diff",
      expected,
      context.baseRefName,
      context.headRefName,
    ],
    // The UI's unversioned diff can belong to an earlier head or an in-flight
    // refresh. Bracket this independent read with the requested MR identity.
    queryFn: async () => {
      verify(await forgePrView(context.repoPath, context.mr.number, lens));
      const diff = await forgePrDiff(context.repoPath, context.mr.number, lens);
      verify(await forgePrView(context.repoPath, context.mr.number, lens));
      return diff;
    },
    staleTime: 0,
    retry: false,
    networkMode: "online",
  });
}
