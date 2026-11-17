import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  MrDocumentDraftScope,
  useMrScopedDraft,
  useMrTextDraft,
} from "@/lib/pulls/mr-document-drafts";

describe("MR document drafts", () => {
  it("retains replies and review summaries under their own document scope", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MrDocumentDraftScope id="doc-a">{children}</MrDocumentDraftScope>
    );
    const first = renderHook(() => useMrScopedDraft("reply|thread-5"), {
      wrapper,
    });
    act(() => first.result.current[1]("Unsent reply"));
    first.unmount();
    const other = renderHook(() => useMrScopedDraft("reply|thread-5"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MrDocumentDraftScope id="doc-b">{children}</MrDocumentDraftScope>
      ),
    });
    expect(other.result.current[0]).toBe("");
    const restored = renderHook(() => useMrScopedDraft("reply|thread-5"), {
      wrapper,
    });
    expect(restored.result.current[0]).toBe("Unsent reply");
  });
  it("retains a draft through unmount and binds a late settle to its original MR", () => {
    const first = renderHook(() => useMrTextDraft("mr-a|comment"));
    act(() => first.result.current.set("A draft"));
    const settleA = first.result.current.clearFor;
    first.unmount();
    const second = renderHook(() => useMrTextDraft("mr-b|comment"));
    act(() => second.result.current.set("B draft"));
    const restored = renderHook(() => useMrTextDraft("mr-a|comment"));
    expect(restored.result.current.value).toBe("A draft");
    act(() => settleA("mr-a|comment"));
    expect(restored.result.current.value).toBe("");
    expect(second.result.current.value).toBe("B draft");
  });
});
