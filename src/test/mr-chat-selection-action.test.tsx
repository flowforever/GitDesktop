import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MrChatSelectionRequest,
  readMrCodeSelection,
} from "@/features/pulls/mr-chat/context";
import { MrChatPane } from "@/features/pulls/mr-chat/MrChatPane";
import {
  MrChatSelectionAction,
  useMrChatSelectionQueue,
} from "@/features/pulls/mr-chat/MrChatSelectionAction";
import { useDiffLayoutStore } from "@/lib/stores/diff-layout";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const SCOPE = {
  mr: { host: "git.example.com", repoFullName: "team/project", number: 7 },
  repoPath: "/repos/project",
  headSha: HEAD,
};

beforeEach(() => {
  useDiffLayoutStore.setState(useDiffLayoutStore.getInitialState());
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function Draft({ onCollapse }: { onCollapse: () => void }) {
  const [value, setValue] = useState("");
  return (
    <aside>
      <button type="button" aria-label="Collapse MR chat" onClick={onCollapse}>
        Collapse
      </button>
      <textarea
        aria-label="Unsent MR question"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </aside>
  );
}

function mount() {
  let scope = SCOPE;
  let enabled: boolean | undefined = true;
  const requested = vi.fn();
  function Harness({
    scope,
    enabled,
  }: {
    scope: typeof SCOPE;
    enabled?: boolean;
  }) {
    const hostRef = useRef<HTMLDivElement>(null);
    return (
      <div className="flex">
        <div
          ref={hostRef}
          data-testid="code-host"
          className="relative min-w-0 flex-1"
        >
          <div
            data-testid="painted-file"
            data-diff-file-path="src/review.ts"
            data-diff-head-sha={HEAD}
          >
            <table>
              <tbody>
                <tr className="diff-line">
                  <td data-side="old" className="diff-line-old-num">
                    <span data-line-num="4">4</span>
                  </td>
                  <td data-side="old" className="diff-line-old-content">
                    <div className="diff-line-content-raw">
                      <span data-template="code" data-testid="old-code">
                        before()
                      </span>
                    </div>
                  </td>
                  <td data-side="new" className="diff-line-new-num">
                    <span data-line-num="4">4</span>
                  </td>
                  <td data-side="new" className="diff-line-new-content">
                    <div className="diff-line-content-raw">
                      <span data-template="code" data-testid="new-code">
                        after()
                      </span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <MrChatSelectionAction
            hostRef={hostRef}
            context={scope}
            enabled={enabled}
            onRequest={requested}
          />
        </div>
        <MrChatPane>
          {({ onCollapse }) => <Draft onCollapse={onCollapse} />}
        </MrChatPane>
      </div>
    );
  }
  const view = render(<Harness scope={scope} enabled={enabled} />);
  return {
    ...view,
    requested,
    update(next: { scope?: typeof SCOPE; enabled?: boolean | undefined }) {
      if (next.scope) scope = next.scope;
      if (Object.hasOwn(next, "enabled")) enabled = next.enabled;
      view.rerender(<Harness scope={scope} enabled={enabled} />);
    },
  };
}

function selectCode(side: "old" | "new" = "new") {
  const code = screen.getByTestId(`${side}-code`);
  const text = code.firstChild;
  if (!text) throw new Error("Missing code text");
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, text.textContent?.length ?? 0);
  range.getBoundingClientRect = () =>
    ({
      x: 240,
      y: 180,
      top: 180,
      left: 240,
      right: 400,
      bottom: 200,
      width: 160,
      height: 20,
      toJSON: () => ({}),
    }) as DOMRect;
  act(() => {
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.mouseUp(code);
  });
  const host = screen.getByTestId("code-host");
  if (
    !code.closest("[inert]") &&
    code.closest("[data-diff-head-sha]")?.getAttribute("data-diff-head-sha") ===
      HEAD
  )
    expect(readMrCodeSelection(host)).toMatchObject({
      text: side === "new" ? "after()" : "before()",
      headSha: HEAD,
      side,
    });
}

describe("Add selected MR code to chat", () => {
  it("preserves the browser selection and unsent draft while opening collapsed chat and queuing the selected code", async () => {
    const user = userEvent.setup();
    const view = mount();
    await user.type(
      screen.getByRole("textbox", { name: "Unsent MR question" }),
      "Keep this unsent question",
    );
    await user.click(screen.getByRole("button", { name: "Collapse MR chat" }));
    selectCode();
    const action = await screen.findByRole("button", { name: "Add to chat" });
    expect(document.getSelection()?.toString()).toBe("after()");
    await user.click(action);
    expect(document.getSelection()?.toString()).toBe("after()");
    expect(useDiffLayoutStore.getState().mrChatCollapsed).toBe(false);
    expect(
      screen.getByRole("textbox", { name: "Unsent MR question" }),
    ).toHaveValue("Keep this unsent question");
    expect(view.requested).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        mr: SCOPE.mr,
        repoPath: SCOPE.repoPath,
        headSha: HEAD,
        selection: expect.objectContaining({
          kind: "selection",
          path: "src/review.ts",
          side: "new",
          startLine: 4,
          endLine: 4,
          text: "after()",
        }),
      }),
    );
  });

  it("has no action by default while disabled and requires a new gesture after becoming active", () => {
    const view = mount();
    view.update({ enabled: undefined });
    selectCode();
    expect(
      screen.queryByRole("button", { name: "Add to chat" }),
    ).not.toBeInTheDocument();
    view.update({ enabled: true });
    expect(
      screen.queryByRole("button", { name: "Add to chat" }),
    ).not.toBeInTheDocument();
    selectCode();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeVisible();
    expect(view.requested).not.toHaveBeenCalled();
  });

  it.each(["different head", "held slot"])(
    "does not offer code from a %s",
    (reason) => {
      const view = mount();
      const marker = screen.getByTestId("painted-file");
      if (reason === "different head") marker.dataset.diffHeadSha = OTHER_HEAD;
      else marker.setAttribute("inert", "");
      selectCode();
      expect(
        screen.queryByRole("button", { name: "Add to chat" }),
      ).not.toBeInTheDocument();
      expect(view.requested).not.toHaveBeenCalled();
    },
  );

  it("retires a selection when the MR or head changes and when its painted source becomes held", async () => {
    const view = mount();
    selectCode();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeVisible();
    view.update({ scope: { ...SCOPE, mr: { ...SCOPE.mr, number: 8 } } });
    expect(
      screen.queryByRole("button", { name: "Add to chat" }),
    ).not.toBeInTheDocument();
    selectCode("old");
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeVisible();
    act(() => screen.getByTestId("painted-file").setAttribute("inert", ""));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Add to chat" }),
      ).not.toBeInTheDocument(),
    );
    expect(view.requested).not.toHaveBeenCalled();
  });
});

function request(id: string): MrChatSelectionRequest {
  return {
    ...SCOPE,
    id,
    selection: {
      id: `selection-${id}`,
      kind: "selection",
      path: "src/review.ts",
      side: "new",
      text: "after()",
      format: "code",
      headSha: HEAD,
    },
  };
}

describe("MR selection request queue", () => {
  it("consumes only the matching request and rejects requests for another MR or head", () => {
    const view = renderHook(() => useMrChatSelectionQueue(SCOPE, true));
    act(() => view.result.current.enqueue(request("first")));
    act(() => view.result.current.enqueue(request("next")));
    act(() => view.result.current.consume("first"));
    expect(view.result.current.request?.id).toBe("next");
    act(() =>
      view.result.current.enqueue({
        ...request("wrong-head"),
        headSha: OTHER_HEAD,
      }),
    );
    act(() =>
      view.result.current.enqueue({
        ...request("wrong-mr"),
        mr: { ...SCOPE.mr, number: 8 },
      }),
    );
    expect(view.result.current.request?.id).toBe("next");
    act(() => view.result.current.consume("next"));
    expect(view.result.current.request).toBeUndefined();
  });

  it("retires queued selections on MR switches, head changes, and deactivation", () => {
    const view = renderHook(
      ({ scope, enabled }) => useMrChatSelectionQueue(scope, enabled),
      { initialProps: { scope: SCOPE, enabled: true } },
    );
    act(() => view.result.current.enqueue(request("first")));
    view.rerender({ scope: { ...SCOPE, headSha: OTHER_HEAD }, enabled: true });
    expect(view.result.current.request).toBeUndefined();
    view.rerender({ scope: SCOPE, enabled: true });
    expect(view.result.current.request).toBeUndefined();
    act(() => view.result.current.enqueue(request("second")));
    view.rerender({ scope: SCOPE, enabled: false });
    view.rerender({ scope: SCOPE, enabled: true });
    expect(view.result.current.request).toBeUndefined();
  });
});
