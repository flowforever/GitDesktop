import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentNarration } from "@/features/sessions/AgentNarration";
import { SessionConversationView } from "@/features/sessions/SessionConversationView";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

const external = vi.hoisted(() => ({ editor: vi.fn() }));
vi.mock("@/features/sessions/useOpenFile", () => ({
  useOpenFile: () => external.editor,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
const clients: QueryClient[] = [];
function mount(child: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{child}</QueryClientProvider>,
  );
}
beforeEach(() => {
  external.editor.mockReset();
  vi.mocked(openUrl).mockClear();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe("MR chat file references", () => {
  it("routes an inline code path to the MR while preserving its line locator", async () => {
    const open = vi.fn();
    mount(
      <AgentNarration
        text="Inspect `src/cache.ts:42:3`."
        baseDir="/repo"
        onOpenFile={open}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open src/cache.ts" }),
    );
    expect(open).toHaveBeenCalledWith("src/cache.ts:42:3");
    expect(external.editor).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("activates inline references with %s", (key) => {
    const open = vi.fn();
    mount(
      <AgentNarration
        text="Inspect `src/cache.ts#L8`."
        baseDir="/repo"
        onOpenFile={open}
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Open src/cache.ts" }),
      { key },
    );
    expect(open).toHaveBeenCalledWith("src/cache.ts#L8");
    expect(external.editor).not.toHaveBeenCalled();
  });

  it.each(["src/cache.ts#L9", "/repo/src/cache.ts:9", "Dockerfile"])(
    "claims a Markdown file link before the shared browser handler (%s)",
    async (reference) => {
      const open = vi.fn();
      mount(
        <AgentNarration
          text={`See [changed file](${reference}).`}
          baseDir="/repo"
          onOpenFile={open}
        />,
      );
      await userEvent.click(screen.getByRole("link", { name: "changed file" }));
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(reference);
      expect(openUrl).not.toHaveBeenCalled();
      expect(external.editor).not.toHaveBeenCalled();
    },
  );

  it("claims middle clicks on Markdown file links", () => {
    const open = vi.fn();
    mount(
      <AgentNarration
        text="See [cache](src/cache.ts#L9)."
        baseDir="/repo"
        onOpenFile={open}
      />,
    );
    fireEvent(
      screen.getByRole("link", { name: "cache" }),
      new MouseEvent("auxclick", { button: 1, bubbles: true }),
    );
    expect(open).toHaveBeenCalledWith("src/cache.ts#L9");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("leaves external URLs to the shared browser link handler", async () => {
    const open = vi.fn();
    mount(
      <AgentNarration
        text="See [docs](https://example.com/code.ts)."
        baseDir="/repo"
        onOpenFile={open}
      />,
    );
    await userEvent.click(screen.getByRole("link", { name: "docs" }));
    expect(open).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/code.ts");
  });

  it("preserves a Windows drive prefix in an inline file reference", async () => {
    const open = vi.fn();
    mount(
      <AgentNarration
        text="Inspect `C:/repos/project/src/cache.ts:9`."
        baseDir="C:/repos/project"
        onOpenFile={open}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Open C:/repos/project/src/cache.ts",
      }),
    );
    expect(open).toHaveBeenCalledWith("C:/repos/project/src/cache.ts:9");
  });

  it("does not make a sanitized scheme link executable", async () => {
    const open = vi.fn();
    mount(
      <AgentNarration
        text="[unsafe](javascript:alert(1))"
        baseDir="/repo"
        onOpenFile={open}
      />,
    );
    await userEvent.click(screen.getByText("unsafe"));
    expect(open).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("keeps regular session references opening in the configured editor", async () => {
    mount(<AgentNarration text="Inspect `src/cache.ts:42`." baseDir="/repo" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Open src/cache.ts" }),
    );
    expect(external.editor).toHaveBeenCalledWith("/repo", "src/cache.ts");
  });

  it.each([false, true])(
    "passes the MR handler through %s streamed segments",
    async (streamed) => {
      const open = vi.fn();
      const text = "Inspect [cache](src/cache.ts#L42).";
      mount(
        <SessionConversationView
          baseDir="/repo"
          onOpenFile={open}
          readOnly
          footer={<span>Composer</span>}
          turns={[
            {
              prompt: "Explain",
              narration: text,
              segments: streamed ? [{ type: "text", text }] : [],
              status: "done",
              statusText: "",
              commitHash: null,
              costUsd: null,
              error: null,
            },
          ]}
        />,
      );
      await userEvent.click(screen.getByRole("link", { name: "cache" }));
      expect(open).toHaveBeenCalledWith("src/cache.ts#L42");
      expect(openUrl).not.toHaveBeenCalled();
    },
  );
});
