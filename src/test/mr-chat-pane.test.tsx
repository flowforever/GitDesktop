import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MrChatPane } from "@/features/pulls/mr-chat/MrChatPane";
import { useDiffLayoutStore } from "@/lib/stores/diff-layout";

const observers = new Set<{
  target: Element | null;
  callback: ResizeObserverCallback;
}>();

beforeEach(() => {
  useDiffLayoutStore.setState(useDiffLayoutStore.getInitialState());
  observers.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      target: Element | null = null;
      readonly callback: ResizeObserverCallback;
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
      // Measuring the pane itself would feed its chosen width back as the row
      // width; give those two boxes distinct sizes to catch that feedback loop.
      const width =
        this.getAttribute("aria-label") === "MR chat pane"
          ? Number.parseFloat(this.style.width) || 384
          : Number(
              this.closest("[data-layout-width]")?.getAttribute(
                "data-layout-width",
              ) ?? 1400,
            );
      return { width, left: 0, right: width, top: 0, bottom: 600 } as DOMRect;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function StatefulChat({ onCollapse }: { onCollapse: () => void }) {
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState(false);
  const [session, setSession] = useState("New chat");
  return (
    <aside aria-label="MR chat">
      <button type="button" aria-label="Collapse MR chat" onClick={onCollapse}>
        Collapse MR chat
      </button>
      <textarea
        aria-label="Message"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="button" onClick={() => setAttached(true)}>
        Attach selected lines
      </button>
      {attached && <p>src/review.ts lines 10–20</p>}
      <button type="button" onClick={() => setSession("Ongoing chat")}>
        Start chat
      </button>
      <output aria-label="Chat session">{session}</output>
    </aside>
  );
}

function mount() {
  let mr = "first";
  const tree = () => (
    <div
      data-layout-width="1400"
      data-testid="review-row"
      className="flex min-w-0"
    >
      <main className="min-w-0 flex-1">Code preview</main>
      <MrChatPane key={mr}>
        {({ onCollapse }) => <StatefulChat onCollapse={onCollapse} />}
      </MrChatPane>
    </div>
  );
  const view = render(tree());
  return {
    ...view,
    selectMr(next: string) {
      mr = next;
      view.rerender(tree());
    },
    resizeRow(width: number) {
      const row = screen.getByTestId("review-row");
      row.setAttribute("data-layout-width", String(width));
      act(() => {
        for (const observer of observers) {
          if (observer.target === row)
            observer.callback(
              [
                {
                  target: row,
                  borderBoxSize: [{ inlineSize: width }],
                } as unknown as ResizeObserverEntry,
              ],
              observer as unknown as ResizeObserver,
            );
        }
      });
    },
  };
}

const handle = () => screen.getByRole("separator", { name: "Resize MR chat" });
const pane = () => screen.getByRole("group", { name: "MR chat pane" });
const width = () => Number.parseFloat(pane().style.width);

function pointer(target: Element, type: string, clientX: number) {
  fireEvent(
    target,
    Object.assign(new MouseEvent(type, { bubbles: true, clientX, button: 0 }), {
      pointerId: 7,
      isPrimary: true,
    }),
  );
}

describe("docked MR chat pane", () => {
  it("collapses to an expand strip without losing a draft, attachments, or ongoing chat", async () => {
    mount();
    const draft = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(draft, "Explain this change");
    await userEvent.click(
      screen.getByRole("button", { name: "Attach selected lines" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse MR chat" }),
    );
    const expand = screen.getByRole("button", { name: "Expand MR chat" });
    expect(expand).toHaveFocus();
    expect(width()).toBeLessThanOrEqual(36);
    expect(
      screen.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize MR chat" }),
    ).not.toBeInTheDocument();
    await userEvent.click(expand);
    expect(
      screen.getByRole("button", { name: "Collapse MR chat" }),
    ).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(draft);
    expect(draft).toHaveValue("Explain this change");
    expect(screen.getByText("src/review.ts lines 10–20")).toBeVisible();
    expect(screen.getByLabelText("Chat session")).toHaveTextContent(
      "Ongoing chat",
    );
  });

  it("grows the right pane while its left boundary is dragged left", () => {
    mount();
    const initial = width();
    const separator = handle();
    expect(initial).toBe(384);
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    pointer(separator, "pointerdown", 1000);
    pointer(separator, "pointermove", 880);
    expect(width()).toBe(initial + 120);
    pointer(separator, "pointerup", 880);
    pointer(separator, "pointermove", 700);
    expect(width()).toBe(initial + 120);
    expect(document.body.style.cursor).not.toBe("col-resize");
  });

  it("moves the boundary with arrow keys and clamps both keyboard edges", () => {
    mount();
    const separator = handle();
    separator.focus();
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(width()).toBeGreaterThan(384);
    const grown = width();
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(width()).toBeLessThan(grown);
    fireEvent.keyDown(separator, { key: "Home" });
    expect(width()).toBe(288);
    fireEvent.keyDown(separator, { key: "End" });
    expect(width()).toBe(760);
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });
    expect(width()).toBe(760);
  });

  it("clamps against the parent row and restores the preferred width when room returns", () => {
    const view = mount();
    fireEvent.keyDown(handle(), { key: "End" });
    view.resizeRow(800);
    expect(width()).toBe(480);
    view.resizeRow(1400);
    expect(width()).toBe(760);
  });

  it("retains width and collapse preferences when another MR mounts", async () => {
    const view = mount();
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    const preferred = width();
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse MR chat" }),
    );
    view.selectMr("next");
    expect(
      screen.queryByRole("separator", { name: "Resize MR chat" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Expand MR chat" }),
    );
    expect(width()).toBe(preferred);
  });
});
