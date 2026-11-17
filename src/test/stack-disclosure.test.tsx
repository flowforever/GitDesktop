import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { StackSection } from "@/features/pulls/StackSection";

type StackProps = ComponentProps<typeof StackSection>;

function stackProps(overrides: Partial<StackProps> = {}): StackProps {
  return {
    stack: { id: "7", position: 2, size: 5 },
    members: [
      {
        number: 12,
        title: "Top member",
        state: "open",
        position: 3,
        headRefName: "top",
        baseRefName: "middle",
      },
      {
        number: 10,
        title: "Bottom member",
        state: "merged",
        position: 1,
        headRefName: "bottom",
        baseRefName: "main",
      },
      {
        number: 11,
        title: "Middle member",
        state: "open",
        position: 2,
        headRefName: "middle",
        baseRefName: "bottom",
      },
    ],
    membersUnknown: false,
    detailsPaused: false,
    onRetryMembers: vi.fn(),
    currentNumber: 11,
    onSelect: vi.fn(),
    ...overrides,
  };
}

describe("stack member disclosure", () => {
  it("keeps the summary and Dissolve reachable while members start collapsed", async () => {
    const user = userEvent.setup();
    const onDissolve = vi.fn();
    const props = stackProps({ onDissolve });
    render(<StackSection {...props} />);

    expect(screen.getByText("Stack · 2 of 3")).toBeVisible();
    expect(screen.queryByRole("button", { name: /#10/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /#11/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /#12/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show stack members" }),
    ).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Dissolve" }));
    expect(onDissolve).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("shows and hides members with the keyboard while keeping focus on the control", async () => {
    const user = userEvent.setup();
    const props = stackProps();
    render(<StackSection {...props} />);
    const disclosure = screen.getByRole("button", {
      name: "Show stack members",
    });

    await user.tab();
    expect(disclosure).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(disclosure).toHaveAccessibleName("Hide stack members");
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const controlledId = disclosure.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    expect(document.getElementById(controlledId ?? "")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /#1[012]/ })).toEqual([
      screen.getByRole("button", { name: /#10/ }),
      screen.getByRole("button", { name: /#11/ }),
      screen.getByRole("button", { name: /#12/ }),
    ]);
    expect(screen.getByRole("button", { name: /#11/ })).toHaveAttribute(
      "aria-current",
      "true",
    );

    await user.keyboard(" ");

    expect(disclosure).toHaveAccessibleName("Show stack members");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveFocus();
    expect(screen.queryByRole("button", { name: /#11/ })).toBeNull();
    expect(screen.getByText("Stack · 2 of 3")).toBeVisible();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("keeps a failed member lookup visible with Retry and its known stack size", () => {
    const props = stackProps({ members: undefined, membersUnknown: true });
    render(<StackSection {...props} />);

    expect(screen.getByText("Stack · 2 of 5")).toBeVisible();
    expect(
      screen.getByText("Couldn't load the stack's members."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Show stack members" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading stack members" }),
    );
    expect(props.onRetryMembers).toHaveBeenCalledOnce();
  });

  it("keeps the offline notice visible without offering a parked Retry", () => {
    render(
      <StackSection
        {...stackProps({
          members: undefined,
          membersUnknown: true,
          detailsPaused: true,
        })}
      />,
    );

    expect(screen.getByText("Stack · 2 of 5")).toBeVisible();
    expect(screen.getByText(/offline.*stack's members/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show stack members" }),
    ).toBeNull();
  });

  it("keeps a single-member stack actionable without an empty disclosure", () => {
    const props = stackProps({
      stack: { id: "7", position: 1, size: 5 },
      currentNumber: 10,
      onDissolve: vi.fn(),
    });
    render(<StackSection {...props} members={props.members?.slice(1, 2)} />);

    expect(screen.getByText("Stack · 1 of 1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Dissolve" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /stack members/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /#10/ })).toBeNull();
  });

  it("renders no stack controls when the displayed pull request is unstacked", () => {
    const props = stackProps();
    const view = render(<StackSection {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show stack members" }));

    view.rerender(<StackSection {...props} stack={null} />);

    expect(screen.queryByText(/Stack ·/)).toBeNull();
    expect(screen.queryByRole("button", { name: /stack members/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /#11/ })).toBeNull();
  });
});
