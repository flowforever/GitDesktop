import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PrChangedFilesNav } from "@/features/pulls/PrChangedFilesNav";
import { TabPanel } from "@/features/repository/TabPanel";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";

const CHANGED = [
  { path: "README.md" },
  { path: "src/file10.ts" },
  { path: "assets/icon.svg" },
  { path: "src/file2.ts" },
] as const;
const ALL_FILES = [
  ...CHANGED,
  { path: "assets/a.txt" },
  { path: "assets/readme.txt" },
  { path: "docs/guide.md" },
  { path: "src/nested/helper.ts" },
  { path: "src/file3.ts" },
  { path: "z-unchanged.ts" },
] as const;
const PREVIOUS = "pr-previous-changed-file";
const NEXT = "pr-next-changed-file";
const previous = () =>
  screen.getByRole("button", { name: "Previous changed file" });
const next = () => screen.getByRole("button", { name: "Next changed file" });

function dispatch(id: typeof PREVIOUS | typeof NEXT): boolean {
  let handled = false;
  act(() => {
    handled = dispatchAction(id);
  });
  return handled;
}

function SelectionHarness({ allFiles = false }: { allFiles?: boolean }) {
  const [path, setPath] = useState<string | null>("assets/icon.svg");
  return (
    <>
      <output aria-label="Selected file">{path}</output>
      <PrChangedFilesNav
        files={CHANGED}
        treeFiles={allFiles ? ALL_FILES : undefined}
        currentPath={path}
        onSelectPath={setPath}
      />
    </>
  );
}

describe("changed-file navigation", () => {
  it.each([false, true])(
    "follows directory-first numeric leaf order and skips unchanged files (All files: %s)",
    async (allFiles) => {
      const user = userEvent.setup();
      render(<SelectionHarness allFiles={allFiles} />);

      expect(previous()).toBeDisabled();
      expect(dispatch(PREVIOUS)).toBe(false);
      for (const path of ["src/file2.ts", "src/file10.ts", "README.md"]) {
        await user.click(next());
        expect(screen.getByLabelText("Selected file")).toHaveTextContent(path);
      }
      expect(next()).toBeDisabled();
      expect(dispatch(NEXT)).toBe(false);
      await user.click(previous());
      expect(screen.getByLabelText("Selected file")).toHaveTextContent(
        "src/file10.ts",
      );
    },
  );

  it.each([
    ["src/file3.ts", "src/file2.ts", "src/file10.ts"],
    ["docs/guide.md", "assets/icon.svg", "src/file2.ts"],
  ])(
    "finds changed neighbors around the unchanged source file %s",
    async (currentPath, before, after) => {
      const user = userEvent.setup();
      const onSelectPath = vi.fn();
      render(
        <PrChangedFilesNav
          files={CHANGED}
          treeFiles={ALL_FILES}
          currentPath={currentPath}
          onSelectPath={onSelectPath}
        />,
      );

      await user.click(previous());
      await user.click(next());

      // Selection belongs to the caller; both clicks address the same source file.
      expect(onSelectPath.mock.calls).toEqual([[before], [after]]);
    },
  );

  it.each([null, "missing.ts"])(
    "starts at either end when the current path is unknown: %s",
    (currentPath) => {
      const onSelectPath = vi.fn();
      render(
        <PrChangedFilesNav
          files={CHANGED}
          currentPath={currentPath}
          onSelectPath={onSelectPath}
        />,
      );

      expect(dispatch(NEXT)).toBe(true);
      expect(dispatch(PREVIOUS)).toBe(true);
      expect(onSelectPath.mock.calls).toEqual([
        ["assets/icon.svg"],
        ["README.md"],
      ]);
    },
  );

  it.each([
    ["assets/a.txt", "previous", "assets/icon.svg"],
    ["z-unchanged.ts", "next", "README.md"],
  ] as const)(
    "disables the boundary beside unchanged source file %s",
    (currentPath, blocked, target) => {
      const onSelectPath = vi.fn();
      render(
        <PrChangedFilesNav
          files={CHANGED}
          treeFiles={ALL_FILES}
          currentPath={currentPath}
          onSelectPath={onSelectPath}
        />,
      );

      expect(blocked === "previous" ? previous() : next()).toBeDisabled();
      expect(dispatch(blocked === "previous" ? PREVIOUS : NEXT)).toBe(false);
      expect(dispatch(blocked === "previous" ? NEXT : PREVIOUS)).toBe(true);
      expect(onSelectPath).toHaveBeenCalledExactlyOnceWith(target);
    },
  );

  it("offers no navigation when the request has no changed files", () => {
    const onSelectPath = vi.fn();
    render(
      <PrChangedFilesNav
        files={[]}
        treeFiles={ALL_FILES}
        currentPath="docs/guide.md"
        onSelectPath={onSelectPath}
      />,
    );

    expect(previous()).toBeDisabled();
    expect(next()).toBeDisabled();
    expect(dispatch(PREVIOUS)).toBe(false);
    expect(dispatch(NEXT)).toBe(false);
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("disables both clicks and palette actions when the parent holds navigation", () => {
    const onSelectPath = vi.fn();
    const view = (disabled: boolean) => (
      <PrChangedFilesNav
        files={CHANGED}
        currentPath="src/file2.ts"
        onSelectPath={onSelectPath}
        disabled={disabled}
      />
    );
    const host = render(view(false));
    expect(previous()).toBeEnabled();
    expect(next()).toBeEnabled();

    host.rerender(view(true));

    expect(previous()).toBeDisabled();
    expect(next()).toBeDisabled();
    fireEvent.click(previous());
    fireEvent.click(next());
    expect(dispatch(PREVIOUS)).toBe(false);
    expect(dispatch(NEXT)).toBe(false);
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("withdraws palette handlers when its Activity becomes hidden", () => {
    const onSelectPath = vi.fn();
    const view = (active: boolean) => (
      <TabPanel active={active}>
        <PrChangedFilesNav
          files={CHANGED}
          currentPath="src/file2.ts"
          onSelectPath={onSelectPath}
        />
      </TabPanel>
    );
    const host = render(view(true));
    expect(dispatch(NEXT)).toBe(true);
    onSelectPath.mockClear();

    host.rerender(view(false));

    expect(dispatch(PREVIOUS)).toBe(false);
    expect(dispatch(NEXT)).toBe(false);
    expect(onSelectPath).not.toHaveBeenCalled();
  });
});
