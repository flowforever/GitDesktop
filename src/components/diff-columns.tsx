import { type CSSProperties, type ReactNode, useId } from "react";
import { ResizeSeparator } from "@/components/resize-separator";
import { useDiffLayoutStore } from "@/lib/stores/diff-layout";
import { useContainerWidth } from "@/lib/use-container-width";
import "./diff-columns.css";

/** Adjusts either library split layout without replacing its tables or widgets. */
export function DiffColumns({
  mode,
  children,
}: {
  mode: "split" | "unified";
  children: ReactNode;
}) {
  const [measureRef, width] = useContainerWidth<HTMLDivElement>();
  const id = useId();
  const preferred = useDiffLayoutStore((s) => s.oldPanePercent);
  const setPercent = useDiffLayoutStore((s) => s.setOldPanePercent);
  const measuredWidth = width !== null && width > 0 ? width : null;
  const min =
    measuredWidth === null
      ? 20
      : Math.min(50, Math.max(20, (240 / measuredWidth) * 100));
  const max = 100 - min;
  const percent = Math.min(max, Math.max(min, preferred));
  const rounded = Math.round(percent * 10) / 10;
  return (
    <div
      ref={measureRef}
      id={id}
      className="gd-diff-columns"
      style={
        {
          "--gd-diff-old-width": `${percent}%`,
          "--gd-diff-old-width-px":
            measuredWidth === null
              ? undefined
              : `${(measuredWidth * percent) / 100}px`,
          "--gd-diff-new-width-px":
            measuredWidth === null
              ? undefined
              : `${(measuredWidth * (100 - percent)) / 100}px`,
        } as CSSProperties
      }
    >
      {children}
      {mode === "split" && max > min && (
        <ResizeSeparator
          label="Resize old and new diff panes"
          controls={id}
          min={min}
          max={max}
          value={percent}
          valueText={`Old pane ${rounded}%, new pane ${Math.round((100 - percent) * 10) / 10}%`}
          onValueChange={setPercent}
          pixelsPerUnit={measuredWidth === null ? 1 : measuredWidth / 100}
          step={2}
          largeStep={10}
          style={{ left: "var(--gd-diff-old-width)", marginLeft: -4 }}
        />
      )}
    </div>
  );
}
