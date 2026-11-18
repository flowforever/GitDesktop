import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailRail, DetailRailRow } from "@/components/detail-rail";
import type { AppSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useDiffLayoutStore } from "@/lib/stores/diff-layout";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  saveSettingsMerged: vi.fn(async (settings: AppSettings) => settings),
}));

const observers = new Set<{
  callback: ResizeObserverCallback;
  target: Element | null;
}>();

beforeEach(() => {
  useDiffLayoutStore.setState(useDiffLayoutStore.getInitialState());
  observers.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      target: Element | null = null;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.add(this);
      }
      observe(target: Element) {
        this.target = target;
      }
      unobserve() {
        this.target = null;
      }
      disconnect() {
        this.target = null;
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const width = Number(
        this.closest("[data-layout-width]")?.getAttribute(
          "data-layout-width",
        ) ?? 1000,
      );
      return { width, left: 0, right: width, top: 0, bottom: 600 } as DOMRect;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pointer(target: Element, type: string, clientX: number, button = 0) {
  fireEvent(
    target,
    Object.assign(new MouseEvent(type, { bubbles: true, clientX, button }), {
      pointerId: 7,
      isPrimary: true,
    }),
  );
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, {
    ...DEFAULT_SETTINGS,
    diffFileListCollapsed: false,
  });
  let path = "src/deep/long-file-name-that-needs-horizontal-scrolling.ts";
  const tree = () => (
    <QueryClientProvider client={client}>
      <div data-layout-width="1000" data-testid="layout">
        <DetailRailRow>
          <DetailRail key={path} ariaLabel="Changed files">
            <div className="overflow-x-auto whitespace-nowrap">{path}</div>
          </DetailRail>
          <main className="min-w-0 flex-1">
            <textarea
              aria-label="Review draft"
              defaultValue="Keep this draft"
            />
          </main>
        </DetailRailRow>
      </div>
    </QueryClientProvider>
  );
  const view = render(tree());
  const resizeContainer = (width: number) => {
    screen
      .getByTestId("layout")
      .setAttribute("data-layout-width", String(width));
    act(() => {
      for (const observer of observers) {
        if (observer.target?.isConnected)
          observer.callback(
            [
              {
                target: observer.target,
                borderBoxSize: [{ inlineSize: width }],
              } as unknown as ResizeObserverEntry,
            ],
            observer as unknown as ResizeObserver,
          );
      }
    });
  };
  return {
    ...view,
    client,
    resizeContainer,
    selectFile(next: string) {
      path = next;
      view.rerender(tree());
    },
  };
}

const separator = () =>
  screen.getByRole("separator", { name: "Resize file list" });
const railWidth = () =>
  Number.parseFloat(
    screen.getByRole("complementary", { name: "Changed files" }).style.width,
  );

describe("shared file-list resizing", () => {
  it("resizes with the keyboard, clamps both edges, and retains the width on file switches", () => {
    const view = mount();
    const handle = separator();
    const initial = railWidth();
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(railWidth()).toBeGreaterThan(initial);
    const chosen = railWidth();
    view.selectFile("README.md");
    expect(railWidth()).toBe(chosen);
    fireEvent.keyDown(separator(), { key: "End" });
    expect(railWidth()).toBeLessThanOrEqual(776);
    fireEvent.keyDown(separator(), { key: "Home" });
    expect(railWidth()).toBeGreaterThanOrEqual(160);
    expect(screen.getByLabelText("Review draft")).toHaveValue(
      "Keep this draft",
    );
  });

  it("captures a drag and releases it on cancellation without changing a draft", async () => {
    mount();
    const handle = separator();
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    const initial = railWidth();
    pointer(handle, "pointerdown", initial);
    pointer(handle, "pointermove", initial + 120);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
    expect(railWidth()).toBe(initial + 120);
    pointer(handle, "pointercancel", initial + 120);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    const cancelled = railWidth();
    pointer(handle, "pointermove", initial + 240);
    expect(railWidth()).toBe(cancelled);
    expect(document.body.style.userSelect).not.toBe("none");
    await userEvent.type(screen.getByLabelText("Review draft"), " still here");
    expect(screen.getByLabelText("Review draft")).toHaveValue(
      "Keep this draft still here",
    );
  });

  it("restores the chosen width after collapsing and after the container narrows", async () => {
    const view = mount();
    fireEvent.keyDown(separator(), { key: "ArrowRight", shiftKey: true });
    const chosen = railWidth();
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse file list" }),
    );
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Expand file list" }),
    );
    expect(railWidth()).toBe(chosen);
    view.resizeContainer(450);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand file list" }),
    ).toBeVisible();
    view.resizeContainer(1000);
    expect(railWidth()).toBe(chosen);
    expect(view.client.getQueryData(settingsKeys.settings)).toMatchObject({
      diffFileListCollapsed: false,
    });
  });

  it("ignores secondary-button drags and ends a drag on capture loss or unmount", () => {
    const view = mount();
    const handle = separator();
    const initial = railWidth();
    pointer(handle, "pointerdown", 200, 2);
    pointer(handle, "pointermove", 300, 2);
    expect(railWidth()).toBe(initial);
    pointer(handle, "pointerdown", 200);
    pointer(handle, "pointermove", 220);
    pointer(handle, "lostpointercapture", 220);
    const lost = railWidth();
    pointer(handle, "pointermove", 260);
    expect(railWidth()).toBe(lost);
    pointer(handle, "pointerdown", 200);
    view.unmount();
    expect(document.body.style.userSelect).not.toBe("none");
    expect(document.body.style.cursor).not.toBe("col-resize");
  });
});
