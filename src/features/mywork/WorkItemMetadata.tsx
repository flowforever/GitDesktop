import { UserIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import type { MyWorkItem } from "@/lib/git/types";
import { cn } from "@/lib/utils";

type ItemMetadata = Pick<MyWorkItem, "authorLogin" | "labels" | "labelColors">;

function labelStyle(rawColor: unknown): CSSProperties | undefined {
  const color = typeof rawColor === "string" ? rawColor.replace(/^#/, "") : "";
  if (!/^[\da-f]{6}$/i.test(color)) return undefined;
  const rgb = Number.parseInt(color, 16);
  const channel = (shift: number) => {
    const value = ((rgb >> shift) & 0xff) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return {
    backgroundColor: `#${color}`,
    borderColor: `#${color}`,
    color: luminance > 0.179 ? "#000000" : "#ffffff",
  };
}

export function WorkItemAuthor({ login }: { login?: string | null }) {
  if (!login) return null;
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] text-muted-foreground"
      title={`Author: ${login}`}
    >
      <UserIcon className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">Author: </span>
      <span className="truncate">@{login}</span>
    </span>
  );
}

export function WorkItemLabels({
  item,
  className,
}: {
  item: Pick<MyWorkItem, "labels" | "labelColors">;
  className?: string;
}) {
  const labels = [...new Set(item.labels ?? [])];
  if (labels.length === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 flex-wrap items-center gap-1",
        className,
      )}
      title={labels.join(", ")}
    >
      {labels.map((label) => (
        <Badge
          key={label}
          variant="outline"
          className="h-4 min-w-0 max-w-full bg-muted/40 font-normal text-foreground"
          style={labelStyle(item.labelColors?.[label])}
        >
          <span className="truncate" title={label}>
            {label}
          </span>
        </Badge>
      ))}
    </span>
  );
}

/** List responses carry these fields; rows never fetch their own metadata. */
export function WorkItemMetadata({ item }: { item: ItemMetadata }) {
  if (!item.authorLogin && !item.labels?.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <WorkItemAuthor login={item.authorLogin} />
      <WorkItemLabels item={item} />
    </span>
  );
}
