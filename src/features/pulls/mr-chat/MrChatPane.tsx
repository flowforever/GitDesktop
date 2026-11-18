import { ChatCircleIcon } from "@phosphor-icons/react";
import {
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { usePanelActive } from "@/components/panel-portal";
import { ResizeSeparator } from "@/components/resize-separator";
import { Button } from "@/components/ui/button";
import { TabPanel } from "@/features/repository/TabPanel";
import { useDiffLayoutStore } from "@/lib/stores/diff-layout";
import { useContainerWidth } from "@/lib/use-container-width";
import { cn } from "@/lib/utils";

/** A docked chat keeps its content state while the Activity is folded away. */
export function MrChatPane({
  children,
}: {
  children: (controls: { onCollapse: () => void }) => ReactNode;
}) {
  const preferredWidth = useDiffLayoutStore((s) => s.mrChatWidth);
  const collapsed = useDiffLayoutStore((s) => s.mrChatCollapsed);
  const setWidth = useDiffLayoutStore((s) => s.setMrChatWidth);
  const setCollapsed = useDiffLayoutStore((s) => s.setMrChatCollapsed);
  const panelActive = usePanelActive();
  const [measureParent, parentWidth] = useContainerWidth<HTMLElement>();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<"strip" | "chat" | null>(null);
  const bodyId = useId();
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      paneRef.current = node;
      // The pane width is chosen from this measurement, so observe its row.
      measureParent(node?.parentElement ?? null);
    },
    [measureParent],
  );
  const maxWidth =
    parentWidth !== null && parentWidth > 0
      ? Math.min(760, Math.max(0, parentWidth - 320))
      : 760;
  const minWidth = Math.min(288, maxWidth);
  const width = Math.round(
    Math.min(maxWidth, Math.max(minWidth, preferredWidth)),
  );
  const onCollapse = useCallback(() => {
    focusTarget.current = paneRef.current?.contains(document.activeElement)
      ? "strip"
      : null;
    setCollapsed(true);
  }, [setCollapsed]);
  // Resizing only changes layout; reuse the rendered subtree so a drag does
  // not keep re-rendering the conversation or rebuilding attachment previews.
  const content = useMemo(
    () => children({ onCollapse }),
    [children, onCollapse],
  );
  useLayoutEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target === "strip" && collapsed) {
      expandRef.current?.focus({ preventScroll: true });
    } else if (target === "chat" && !collapsed) {
      const pane = paneRef.current;
      const control =
        pane?.querySelector<HTMLElement>(
          'button[aria-label="Collapse MR chat"]',
        ) ?? pane?.querySelector<HTMLTextAreaElement>("textarea");
      (control ?? pane)?.focus({ preventScroll: true });
    }
  }, [collapsed]);

  return (
    <div
      ref={attach}
      role="group"
      aria-label="MR chat pane"
      tabIndex={-1}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 shrink-0 flex-col outline-none",
        collapsed && "items-center border-l bg-background",
      )}
      style={{ width: collapsed ? 32 : width }}
    >
      {collapsed && (
        <div className="flex h-10 shrink-0 items-center justify-center">
          <Button
            ref={expandRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Expand MR chat"
            aria-expanded={false}
            aria-controls={bodyId}
            title="Expand MR chat"
            onClick={() => {
              focusTarget.current = "chat";
              setCollapsed(false);
            }}
          >
            <ChatCircleIcon aria-hidden />
          </Button>
        </div>
      )}
      <TabPanel active={panelActive && !collapsed}>
        <div
          id={bodyId}
          className="flex h-full min-h-0 w-full min-w-0 flex-col"
        >
          {content}
        </div>
      </TabPanel>
      {!collapsed && maxWidth > minWidth && (
        <ResizeSeparator
          label="Resize MR chat"
          controls={bodyId}
          value={width}
          min={minWidth}
          max={maxWidth}
          onValueChange={setWidth}
          direction={-1}
          step={16}
          largeStep={48}
          valueText={`${width} pixels`}
          style={{ left: -4 }}
        />
      )}
    </div>
  );
}
