import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffColumns } from "@/components/diff-columns";
import {
  createDiffFile,
  DiffContent,
  GitDiffView,
} from "@/features/diff/DiffSurface";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useDiffLayoutStore } from "@/lib/stores/diff-layout";
import { stubCanvas } from "./canvas-stub";

beforeEach(() => {
  useDiffLayoutStore.setState(useDiffLayoutStore.getInitialState());
  stubCanvas();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({ width: 1000, left: 0, right: 1000, top: 0, bottom: 600 }) as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function text(path: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n one\n-old two\n+new two\n three\n`;
}

const FILE_CONTENT = {
  old: "one\nold two\nthree\n",
  new: "one\nnew two\nthree\n",
};

function mount({ widget = false, fullFile = false, verified = false } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffViewMode: "split",
  });
  let path = "first.txt";
  const lineWidget = widget
    ? {
        enabled: true,
        render: () => (
          <textarea aria-label="Inline review" defaultValue="Unsaved comment" />
        ),
      }
    : undefined;
  const content = () =>
    fullFile ? (
      <GitDiffView
        key={path}
        filePath={path}
        text={text(path)}
        anchorCommit="head-a"
        fullContext
        fileContent={FILE_CONTENT}
        lineWidget={lineWidget}
      />
    ) : (
      <DiffContent
        key={path}
        filePath={path}
        data={{
          filePath: path,
          text: text(path),
          isBinary: false,
          isTruncated: false,
        }}
        isPending={false}
        isError={false}
        anchorCommit="head-a"
        fileContent={verified ? FILE_CONTENT : undefined}
        lineWidget={lineWidget}
        lineAnchors={[
          { side: "new", line: 3, render: () => <p>Existing review thread</p> },
        ]}
      />
    );
  const tree = () => (
    <QueryClientProvider client={client}>{content()}</QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    setMode(mode: "split" | "unified") {
      act(() => {
        client.setQueryData(settingsKeys.settings, {
          ...DEFAULT_SETTINGS,
          diffViewMode: mode,
        });
      });
    },
    async selectFile(next: string) {
      path = next;
      await act(async () => view.rerender(tree()));
    },
  };
}

const separator = () =>
  screen.getByRole("separator", { name: "Resize old and new diff panes" });

function pointer(target: Element, type: string, clientX: number) {
  fireEvent(
    target,
    Object.assign(new MouseEvent(type, { bubbles: true, clientX, button: 0 }), {
      pointerId: 7,
      isPrimary: true,
    }),
  );
}

describe("shared split-diff column resizing", () => {
  it("moves the old/new boundary and keeps the chosen ratio when another file mounts", async () => {
    const view = mount();
    const handle = separator();
    const initial = Number(handle.getAttribute("aria-valuenow"));
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    const chosen = Number(handle.getAttribute("aria-valuenow"));
    expect(chosen).toBeGreaterThan(initial);
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    const painted = screen.getByRole("group", { name: "Diff of first.txt" });
    expect(painted).toHaveAttribute("data-diff-file-path", "first.txt");
    expect(painted.querySelector(".diff-table-old-content-col")).toBeTruthy();
    await view.selectFile("next.txt");
    expect(separator()).toHaveAttribute("aria-valuenow", String(chosen));
    expect(
      screen.getByRole("group", { name: "Diff of next.txt" }),
    ).toHaveAttribute("data-diff-file-path", "next.txt");
  });

  it("clamps pointer resizing while retaining line annotations", () => {
    mount();
    const handle = separator();
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 1600);
    const max = Number(handle.getAttribute("aria-valuemax"));
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(max);
    expect(max).toBeLessThanOrEqual(80);
    pointer(handle, "pointermove", -1000);
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(
      Number(handle.getAttribute("aria-valuemin")),
    );
    pointer(handle, "pointerup", -1000);
    expect(screen.getByText("Existing review thread")).toBeVisible();
  });

  it("keeps an open inline draft mounted during resize", async () => {
    const view = mount({ widget: true });
    const line = view.container.querySelector<HTMLSpanElement>(
      'td[data-side="new"] [data-line-num="2"]',
    );
    const add = line?.closest("td")?.querySelector<HTMLButtonElement>("button");
    expect(add).toBeTruthy();
    await userEvent.click(add as HTMLButtonElement);
    const draft = await screen.findByLabelText("Inline review");
    await userEvent.type(draft, " with edits");
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(screen.getByLabelText("Inline review")).toBe(draft);
    expect(draft).toHaveValue("Unsaved comment with edits");
    expect(screen.getByText("Existing review thread")).toBeVisible();
  });

  it("uses the same handle in Full file and hides it in unified mode", async () => {
    const view = mount({ fullFile: true });
    const initial = Number(separator().getAttribute("aria-valuenow"));
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(Number(separator().getAttribute("aria-valuenow"))).toBeLessThan(
      initial,
    );
    view.setMode("unified");
    await waitFor(() => {
      expect(
        view.container.querySelector(".unified-diff-view"),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("separator", { name: /Resize old and new/ }),
      ).not.toBeInTheDocument();
    });
    view.setMode("split");
    await waitFor(() => {
      expect(
        view.container.querySelector(".split-diff-view"),
      ).toBeInTheDocument();
      expect(separator()).toBeVisible();
    });
  });

  it("keeps the independent no-wrap scrollers mounted during resizing", () => {
    const diff = createDiffFile("nowrap.txt", text("nowrap.txt"));
    const view = render(
      <DiffColumns mode="split">
        <DiffView
          diffFile={diff ?? undefined}
          diffViewMode={DiffModeEnum.Split}
        />
      </DiffColumns>,
    );
    const old = view.container.querySelector<HTMLElement>(
      ".old-diff-table-wrapper",
    );
    const next = view.container.querySelector<HTMLElement>(
      ".new-diff-table-wrapper",
    );
    expect(old).toBeTruthy();
    expect(next).toBeTruthy();
    if (!old || !next) throw new Error("Missing no-wrap scrollers");
    old.scrollLeft = 42;
    next.scrollLeft = 42;
    const columns = separator().parentElement;
    const initial = columns?.style.getPropertyValue("--gd-diff-old-width");
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(columns?.style.getPropertyValue("--gd-diff-old-width")).not.toBe(
      initial,
    );
    expect(view.container.querySelector(".old-diff-table-wrapper")).toBe(old);
    expect(view.container.querySelector(".new-diff-table-wrapper")).toBe(next);
    expect(old.scrollLeft).toBe(42);
    expect(next.scrollLeft).toBe(42);
  });

  it("supplies measured pixel widths to wrapped columns during dragging and container resizing", () => {
    const observers: {
      target?: Element;
      callback: ResizeObserverCallback;
    }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        target?: Element;
        readonly callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
          observers.push(this);
        }
        observe(target: Element) {
          this.target = target;
        }
        unobserve() {
          this.target = undefined;
        }
        disconnect() {
          this.target = undefined;
        }
      },
    );
    const diff = createDiffFile("wrapped.txt", text("wrapped.txt"));
    render(
      <DiffColumns mode="split">
        <DiffView
          diffFile={diff ?? undefined}
          diffViewMode={DiffModeEnum.Split}
          diffViewWrap
        />
      </DiffColumns>,
    );
    const handle = separator();
    const columns = handle.parentElement;
    if (!columns) throw new Error("Missing split columns");
    const sizes = () => [
      columns.style.getPropertyValue("--gd-diff-old-width-px"),
      columns.style.getPropertyValue("--gd-diff-new-width-px"),
    ];
    expect(sizes()).toEqual(["500px", "500px"]);
    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 600);
    pointer(handle, "pointerup", 600);
    expect(sizes()).toEqual(["600px", "400px"]);
    const resize = (width: number) => {
      act(() => {
        for (const observer of observers) {
          if (observer.target === columns)
            observer.callback(
              [
                {
                  target: columns,
                  borderBoxSize: [{ inlineSize: width }],
                } as unknown as ResizeObserverEntry,
              ],
              observer as unknown as ResizeObserver,
            );
        }
      });
    };
    resize(800);
    expect(sizes()).toEqual(["480px", "320px"]);
    resize(400);
    expect(sizes()).toEqual(["200px", "200px"]);
    resize(1000);
    expect(sizes()).toEqual(["600px", "400px"]);
    expect(separator()).toHaveAttribute("aria-valuenow", "60");
  });

  it("publishes head provenance only with a verified file model", () => {
    const raw = mount();
    expect(
      screen.getByRole("group", { name: "Diff of first.txt" }),
    ).not.toHaveAttribute("data-diff-head-sha");
    raw.unmount();
    mount({ verified: true });
    expect(
      screen.getByRole("group", { name: "Diff of first.txt" }),
    ).toHaveAttribute("data-diff-head-sha", "head-a");
  });
});
