import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { cn } from "@/lib/utils";
import "./resize-separator.css";

interface ResizeDrag {
  target: HTMLDivElement;
  pointerId: number;
  startX: number;
  startValue: number;
  pixelsPerUnit: number;
  direction: 1 | -1;
  restoreStyle: () => void;
}

function releaseDrag(ref: { current: ResizeDrag | null }) {
  const drag = ref.current;
  if (drag === null) return null;
  ref.current = null;
  if (drag.target.hasPointerCapture?.(drag.pointerId))
    drag.target.releasePointerCapture(drag.pointerId);
  drag.restoreStyle();
  return drag;
}

/** A vertical pane boundary; units may be pixels or a container percentage. */
export function ResizeSeparator({
  label,
  value,
  min,
  max,
  onValueChange,
  pixelsPerUnit = 1,
  direction = 1,
  step = 1,
  largeStep = step * 4,
  valueText,
  controls,
  className,
  style,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onValueChange: (value: number) => void;
  pixelsPerUnit?: number;
  /** Boundary movement as the pane's value increases. */
  direction?: 1 | -1;
  step?: number;
  largeStep?: number;
  valueText?: string;
  controls?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const dragRef = useRef<ResizeDrag | null>(null);
  const [resizing, setResizing] = useState(false);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const finish = () => {
    releaseDrag(dragRef);
    setResizing(false);
  };
  useEffect(() => {
    const blur = () => {
      releaseDrag(dragRef);
      setResizing(false);
    };
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      releaseDrag(dragRef);
    };
  }, []);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    onValueChange(
      clamp(
        drag.startValue +
          ((event.clientX - drag.startX) * drag.direction) / drag.pixelsPerUnit,
      ),
    );
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-controls={controls}
      aria-disabled={min === max || undefined}
      tabIndex={0}
      title={`${label} (Left/Right arrows; Shift for larger steps)`}
      className={cn("gd-resize-separator", className)}
      style={style}
      data-resizing={resizing || undefined}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          event.isPrimary === false ||
          max <= min ||
          pixelsPerUnit <= 0
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        releaseDrag(dragRef);
        const target = event.currentTarget;
        target.focus({ preventScroll: true });
        target.setPointerCapture?.(event.pointerId);
        const { cursor, userSelect } = document.body.style;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        dragRef.current = {
          target,
          pointerId: event.pointerId,
          startX: event.clientX,
          startValue: value,
          pixelsPerUnit,
          direction,
          restoreStyle: () => {
            document.body.style.cursor = cursor;
            document.body.style.userSelect = userSelect;
          },
        };
        setResizing(true);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        move(event);
        finish();
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) finish();
      }}
      onLostPointerCapture={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) finish();
      }}
      onKeyDown={(event) => {
        if (hasChordModifier(event)) return;
        if (event.key === "Escape" && dragRef.current !== null) {
          event.preventDefault();
          event.stopPropagation();
          const initial = dragRef.current.startValue;
          finish();
          onValueChange(clamp(initial));
          return;
        }
        const amount = (event.shiftKey ? largeStep : step) * direction;
        let next: number;
        switch (event.key) {
          case "ArrowLeft":
            next = value - amount;
            break;
          case "ArrowRight":
            next = value + amount;
            break;
          case "Home":
            next = min;
            break;
          case "End":
            next = max;
            break;
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        onValueChange(clamp(next));
      }}
    />
  );
}
