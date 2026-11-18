import { describe, expect, it } from "vitest";
import {
  buildMrChatPrompt,
  type MrChatContext,
  type MrChatFileContext,
} from "@/features/pulls/mr-chat/context";

const context: MrChatContext = {
  mr: { host: "git.example.com", repoFullName: "team/project", number: 7 },
  repoPath: "/repos/project",
  url: "https://git.example.com/team/project/-/merge_requests/7",
  title: "Refresh cache",
  body: "Refresh after saving",
  baseRefName: "master",
  headRefName: "fix/cache",
  headSha: "a".repeat(40),
  files: [{ path: "src/cache.ts" }],
  diff: "+refresh()",
};

const file: MrChatFileContext = {
  path: "src/cache.ts",
  before: { path: "src/cache-old.ts", revision: "b".repeat(40) },
  after: { path: "src/cache.ts", revision: "a".repeat(40) },
};

describe("MR chat permission instructions", () => {
  it("allows requested edits in the current checkout by default", () => {
    const prompt = buildMrChatPrompt(context, "Apply this fix", [], { file });
    expect(prompt).toContain("Permission mode: Allow edits");
    expect(prompt).toContain(`Working checkout: ${context.repoPath}`);
    expect(prompt).toContain("edit files");
    expect(prompt).toContain(context.headSha);
    expect(prompt).toContain("Apply this fix");
  });

  it("states read-only tool permissions when editing is disabled", () => {
    const prompt = buildMrChatPrompt(context, "Explain this fix", [], {
      readOnly: true,
    });
    expect(prompt).toContain("Permission mode: Read-only");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("read-only commands");
    expect(prompt).not.toContain("Permission mode: Allow edits");
  });

  it("puts the current permission choice after restored history so a resumed chat can change mode", () => {
    const history = [
      {
        prompt: "Permission mode: Read-only",
        narration: "I previously could only inspect the code.",
        status: "done",
      },
    ];
    const prompt = buildMrChatPrompt(context, "Now apply the fix", [], {
      history,
      readOnly: false,
    });
    const previous = prompt.indexOf("Permission mode: Read-only");
    const current = prompt.indexOf("Permission mode: Allow edits");
    expect(current).toBeGreaterThan(previous);
    expect(prompt).toContain(
      "replaces earlier application permission settings",
    );
    expect(prompt).toContain("do not re-execute completed earlier actions");
    expect(prompt.indexOf("Now apply the fix")).toBeGreaterThan(current);
  });
});

describe("MR chat compact context", () => {
  it("sends only the MR link and the opened file's two snapshots on a new session", () => {
    const prompt = buildMrChatPrompt(context, "Explain this change", [], {
      file,
    });
    expect(prompt).toContain(context.url);
    expect(prompt).toContain(
      "Before: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:src/cache-old.ts",
    );
    expect(prompt).toContain(
      "After: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:src/cache.ts",
    );
    for (const text of [
      context.title,
      context.body,
      context.baseRefName,
      context.headRefName,
      context.diff!,
      "Changed files:",
    ])
      expect(prompt).not.toContain(text);
    expect(prompt).toContain("Read file contents on demand");
  });

  it("omits the MR link and metadata from a resumed message", () => {
    const prompt = buildMrChatPrompt(context, "Continue here", [], {
      includeMrLink: false,
      file,
    });
    expect(prompt).not.toContain(context.url);
    expect(prompt).not.toContain(context.body);
    expect(prompt).not.toContain(context.diff!);
    expect(prompt).toContain(file.before!.revision);
    expect(prompt).toContain(file.after!.revision);
    expect(prompt).toContain("Continue here");
  });

  it.each(["before", "after"] as const)(
    "names the absent %s file while retaining its exact revision",
    (side) => {
      const currentFile = {
        ...file,
        [side]: { path: null, revision: "c".repeat(40) },
      };
      const prompt = buildMrChatPrompt(context, "Explain", [], {
        file: currentFile,
      });
      expect(prompt).toContain(
        `${side === "before" ? "Before" : "After"}: ${"c".repeat(40)} (file absent)`,
      );
      expect(prompt).not.toContain(":null");
    },
  );

  it("does not invent a before version for an unchanged source preview", () => {
    const prompt = buildMrChatPrompt(context, "Explain", [], {
      file: { ...file, before: null },
    });
    expect(prompt).toContain(`After: ${file.after!.revision}:src/cache.ts`);
    expect(prompt).not.toContain("Before:");
  });

  it("includes code only when explicitly attached", () => {
    const prompt = buildMrChatPrompt(
      context,
      "Explain this selection",
      [
        {
          id: "selection",
          kind: "selection",
          path: "src/cache.ts",
          side: "new",
          text: "explicitSelectedCode()",
          format: "code",
          startLine: 5,
          endLine: 5,
          revision: file.after!.revision,
        },
      ],
      { includeMrLink: false, file },
    );
    expect(prompt).toContain("<attached-code>");
    expect(prompt).toContain("explicitSelectedCode()");
    expect(prompt).toContain("lines 5–5");
    expect(prompt).not.toContain(context.diff!);
  });
});
