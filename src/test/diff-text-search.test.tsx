import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffColumns } from "@/components/diff-columns";
import { DiffPaneHold } from "@/features/diff/diff-pane-hold";
import { isMac } from "@/lib/hotkeys/binding";
import { useHotkeyAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/settings/api", async (original) => ({
  ...(await original<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const filter = vi.fn();
const highlights = new Map<string, Set<Range>>();
let client: QueryClient;

function Listener() {
  useHotkeysListener();
  useHotkeyAction("focus-filter", filter);
  return <button type="button">File list</button>;
}

function Code({ text = "needle" }: { text?: string }) {
  return (
    <table>
      <tbody>
        <tr className="diff-line">
          <td className="diff-line-old-content">
            <span className="diff-line-syntax-raw">
              <span data-template>
                <span>need</span>
                <span>le needle</span>
              </span>
            </span>
          </td>
          <td className="diff-line-new-content">
            <span className="diff-line-content-raw">{text}</span>
          </td>
        </tr>
        <tr data-diff-line-widget>
          <td>needle in a comment</td>
        </tr>
      </tbody>
    </table>
  );
}

function wrap(children: ReactNode, interactive = true) {
  return (
    <QueryClientProvider client={client}>
      <Listener />
      <DiffPaneHold
        value={{
          interactive,
          phase: interactive ? "shown" : "held",
          reportSettled: () => () => undefined,
        }}
      >
        <DiffColumns mode="split" searchable>
          {children}
        </DiffColumns>
      </DiffPaneHold>
    </QueryClientProvider>
  );
}

async function find(key = "f") {
  let consumed = false;
  const capture = (event: KeyboardEvent) => {
    if (event.key === key) consumed = event.defaultPrevented;
  };
  window.addEventListener("keydown", capture);
  try {
    await userEvent
      .setup()
      .keyboard(isMac ? `{Meta>}${key}{/Meta}` : `{Control>}${key}{/Control}`);
  } finally {
    window.removeEventListener("keydown", capture);
  }
  return consumed;
}

beforeEach(() => {
  filter.mockClear();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  highlights.clear();
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  vi.stubGlobal("CSS", { ...globalThis.CSS, highlights });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("find in the shared diff", () => {
  it("searches the current file without opening or counting a nested suggestion diff", async () => {
    render(
      wrap(
        <>
          <Code />
          <DiffColumns mode="unified" searchable>
            <Code />
          </DiffColumns>
        </>,
      ),
    );
    await find();
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "needle" },
    });
    await screen.findByText("1 of 3");
  });
  it("does not open a find bar behind a modal's concealed content", async () => {
    const view = render(wrap(<Code />));
    view.container.setAttribute("aria-hidden", "true");
    await find();
    expect(view.container.querySelector('input[type="search"]')).toBeNull();
  });
  it("supports case-sensitive search and Escape from any search control", async () => {
    render(wrap(<Code text="NEEDLE" />));
    await find();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "NEEDLE" },
    });
    await screen.findByText("1 of 3");
    const matchCase = screen.getByRole("button", { name: "Match case" });
    fireEvent.click(matchCase);
    await screen.findByText("1 of 1");
    fireEvent.keyDown(matchCase, { key: "Escape" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(highlights.size).toBe(0);
  });

  it("honors a custom search binding and leaves the filter chord to its original action", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      hotkeys: { "find-in-diff": "mod+g" },
    };
    vi.mocked(loadSettings).mockResolvedValue(settings);
    client.setQueryData(settingsKeys.settings, settings);
    render(wrap(<Code />));
    await find();
    expect(filter).toHaveBeenCalledOnce();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    await find("g");
    expect(
      await screen.findByRole("searchbox", { name: "Find in diff" }),
    ).toHaveFocus();
  });
  it("opens from the shortcut, searches both sides across syntax spans, and navigates matches", async () => {
    render(wrap(<Code />));
    expect(await find()).toBe(true);
    const input = screen.getByRole("searchbox", { name: "Find in diff" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "needle" } });
    await screen.findByText("1 of 3");
    expect(filter).not.toHaveBeenCalled();
    expect([...highlights.values()].some((ranges) => ranges.size === 3)).toBe(
      true,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 of 3")).toBeVisible();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1 of 3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("3 of 3")).toBeVisible();
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("treats punctuation as literal text and clears highlights on Escape", async () => {
    render(wrap(<Code text="literal .*+ marker" />));
    screen.getByRole("button", { name: "File list" }).focus();
    await find();
    const input = screen.getByRole("searchbox", { name: "Find in diff" });
    fireEvent.change(input, { target: { value: ".*+" } });
    await screen.findByText("1 of 1");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "File list" })).toHaveFocus();
    expect(highlights.size).toBe(0);
  });

  it("refreshes results when the displayed diff changes and reports no matches", async () => {
    const view = render(wrap(<Code text="unique" />));
    await find();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "UNIQUE" },
    });
    await screen.findByText("1 of 1");
    view.rerender(wrap(<Code text="changed" />));
    await waitFor(() => expect(screen.getByText("No matches")).toBeVisible());
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
  });

  it("leaves the filter shortcut alone while a diff slot is held", async () => {
    render(wrap(<Code />, false));
    await find();
    expect(filter).toHaveBeenCalledOnce();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});
