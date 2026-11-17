import { Spinner } from "@/components/ui/spinner";
import { DiffPathRow } from "@/features/diff/DiffPathRow";

/** Pending comparison phases keep one path row and visible progress. */
export function PrFullFileLoading({
  filePath,
  message,
}: {
  filePath?: string;
  message: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {filePath !== undefined && <DiffPathRow filePath={filePath} />}
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        <Spinner aria-hidden />
        <p>{message}</p>
      </div>
    </div>
  );
}
