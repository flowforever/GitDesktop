import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrDiffSearch } from "@/features/pulls/PrDiffSearch";
import { isMac } from "@/lib/hotkeys/binding";
import { useHotkeyAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/settings/api", async (original) => ({
  ...(await original<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
const onSelect = vi.fn();
const finder = vi.fn();
const sections = new Map([
  [
    "src/first.ts",
    "diff --git a/src/first.ts b/src/first.ts\n--- a/src/first.ts\n+++ b/src/first.ts\n@@ -10,2 +20,2 @@\n-old needle\n+new needle\n same needle\n",
  ],
  [
    "src/other.ts",
    "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-old\n+needle .*+\n",
  ],
]);
let client: QueryClient;

function Host({
  enabled = true,
  pending = false,
  failed = false,
  incomplete = false,
} = {}) {
  useHotkeysListener();
  useHotkeyAction("show-in-explorer", finder);
  return (
    <PrDiffSearch
      sections={sections}
      enabled={enabled}
      pending={pending}
      failed={failed}
      incomplete={incomplete}
      onSelect={onSelect}
      onRetry={() => undefined}
    />
  );
}
function show(props = {}) {
  return render(
    <QueryClientProvider client={client}>
      <Host {...props} />
    </QueryClientProvider>,
  );
}
async function open() {
  await userEvent
    .setup()
    .keyboard(
      isMac
        ? "{Meta>}{Shift>}f{/Shift}{/Meta}"
        : "{Control>}{Shift>}f{/Shift}{/Control}",
    );
}
beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  onSelect.mockClear();
  finder.mockClear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("CSS", { ...globalThis.CSS, escape: (value: string) => value });
});
afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("search all MR changes", () => {
  it("stays closed until requested", () => {
    show();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("uses the MR shortcut and searches removed, added and context lines across files", async () => {
    show();
    await open();
    const dialog = await screen.findByRole("dialog", {
      name: "Search MR changes",
    });
    const input = within(dialog).getByRole("searchbox", {
      name: "Search MR changes",
    });
    fireEvent.change(input, { target: { value: "NEEDLE" } });
    await screen.findByText("4 matching lines in 2 files");
    expect(finder).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: /src\/first.ts.*Before.*10/ }),
    );
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "src/first.ts",
          side: "old",
          line: 10,
        }),
      ),
    );
  });

  it("matches punctuation literally and supports result navigation with the keyboard", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Search MR changes" }));
    const input = screen.getByRole("searchbox", { name: "Search MR changes" });
    fireEvent.change(input, { target: { value: ".*+" } });
    await screen.findByText("1 matching line in 1 file");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ path: "src/other.ts", side: "new", line: 1 }),
      ),
    );
  });

  it("discloses an incomplete diff instead of claiming complete MR coverage", async () => {
    show({ incomplete: true });
    await open();
    expect(await screen.findByText(/Results may be incomplete/)).toBeVisible();
  });

  it("shows loading and failures without claiming no matches", async () => {
    const view = show({ pending: true });
    await open();
    expect(await screen.findByText("Loading MR diffs…")).toBeVisible();
    view.rerender(
      <QueryClientProvider client={client}>
        <Host failed />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Could not load MR diffs.")).toBeVisible();
  });

  it("does not intercept the shortcut when this MR is inactive", async () => {
    show({ enabled: false });
    await open();
    expect(finder).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
