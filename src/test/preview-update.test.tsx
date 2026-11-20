// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewUpdateNotice } from "@/features/updates/PreviewUpdateNotice";

const { check, getIdentifier, invoke, isTauri, platform } = vi.hoisted(() => ({
  check: vi.fn(),
  getIdentifier: vi.fn(),
  isTauri: vi.fn(),
  invoke: vi.fn(),
  platform: { isMac: false },
}));
vi.mock("@tauri-apps/api/app", () => ({ getIdentifier }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri }));
vi.mock("@/lib/hotkeys/binding", () => ({
  get isMac() {
    return platform.isMac;
  },
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  platform.isMac = false;
  getIdentifier.mockResolvedValue("com.thebguy.gitdesktop.preview");
});

getIdentifier.mockResolvedValue("com.thebguy.gitdesktop.preview");

describe("signed preview updates", () => {
  it("checks on launch but waits for a click before downloading and installing", async () => {
    isTauri.mockReturnValue(true);
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    check.mockResolvedValue({ version: "1.0.2", downloadAndInstall, close });
    const { unmount } = render(<PreviewUpdateNotice />);
    const install = await screen.findByRole("button", {
      name: "Download update",
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("GitDesktop Preview 1.0.2 is available."),
    ).toBeVisible();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    await userEvent.setup().click(install);
    expect(await screen.findByText(/Update installed/)).toBeVisible();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    unmount();
    expect(close).toHaveBeenCalledOnce();
  });

  it("requests the verified macOS handoff and guarded quit only after consent", async () => {
    platform.isMac = true;
    isTauri.mockReturnValue(true);
    invoke.mockResolvedValue(true);
    const downloadAndInstall = vi.fn();
    check.mockResolvedValue({
      version: "1.0.5",
      downloadAndInstall,
      close: vi.fn().mockResolvedValue(undefined),
    });
    render(<PreviewUpdateNotice />);
    const open = await screen.findByRole("button", {
      name: "Download update",
    });
    expect(screen.getByText(/not Apple-notarized/)).toBeVisible();
    expect(invoke).not.toHaveBeenCalled();
    await userEvent.setup().click(open);
    expect(invoke).toHaveBeenCalledWith("preview_open_signed_dmg", {
      expectedVersion: "1.0.5",
    });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Quitting GitDesktop Preview/),
    ).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(/Update installed/)).toBeNull();
  });

  it("reports installation errors and lets the user explicitly retry", async () => {
    isTauri.mockReturnValue(true);
    const downloadAndInstall = vi
      .fn()
      .mockRejectedValue(new Error("bad signature"));
    check.mockResolvedValue({
      version: "1.0.2",
      downloadAndInstall,
      close: vi.fn().mockResolvedValue(undefined),
    });
    const user = userEvent.setup();
    render(<PreviewUpdateNotice />);
    await user.click(
      await screen.findByRole("button", { name: "Download update" }),
    );
    expect(await screen.findByText(/could not be installed/)).toBeVisible();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
  });

  it("dismisses with Later, suppresses the same version on remount, and allows an explicit recheck", async () => {
    isTauri.mockReturnValue(true);
    const close = vi.fn().mockResolvedValue(undefined);
    const downloadAndInstall = vi.fn();
    check.mockImplementation(async () => ({
      version: "1.0.3",
      downloadAndInstall,
      close,
    }));
    const user = userEvent.setup();
    const dialog = () =>
      screen.queryByRole("dialog", { name: "GitDesktop Preview update" });
    const first = render(<PreviewUpdateNotice />);
    const later = await screen.findByRole("button", { name: "Later" });
    await waitFor(() => expect(later).toHaveFocus());
    await user.click(later);
    await waitFor(() => expect(dialog()).toBeNull());
    first.unmount();
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(dialog()).toBeNull();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    const prompt = await screen.findByRole("dialog");
    expect(check).toHaveBeenCalledTimes(3);
    expect(
      within(prompt).getByText("GitDesktop Preview 1.0.3 is available."),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog()).toBeNull());
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("coalesces repeated manual checks but reports their result", async () => {
    isTauri.mockReturnValue(true);
    check.mockResolvedValueOnce(null);
    let finish = (_: null): void => undefined;
    check.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<PreviewUpdateNotice />);
    const manual = await screen.findByRole("button", {
      name: "Check for updates",
    });
    await user.dblClick(manual);
    expect(check).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: "Checking for updates…" }),
    ).toBeDisabled();
    await act(async () => finish(null));
    expect(
      await screen.findByText("No preview update is available."),
    ).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("leaves the macOS app running on open failure, and dismisses into quit guidance if the guard defers exit", async () => {
    platform.isMac = true;
    isTauri.mockReturnValue(true);
    invoke
      .mockRejectedValueOnce(new Error("open failed"))
      .mockResolvedValueOnce(false);
    check.mockResolvedValue({
      version: "1.0.4",
      downloadAndInstall: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const user = userEvent.setup();
    render(<PreviewUpdateNotice />);
    await user.click(
      await screen.findByRole("button", { name: "Download update" }),
    );
    expect(
      await screen.findByText(/could not be verified or opened/),
    ).toBeVisible();
    expect(screen.queryByText(/Quitting GitDesktop Preview/)).toBeNull();
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(/Quit GitDesktop Preview before replacing/),
    ).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("allows only the separate fork stable app in fork stable mode", async () => {
    isTauri.mockReturnValue(true);
    getIdentifier.mockResolvedValueOnce("com.thebguy.gitdesktop.preview");
    const preview = render(<PreviewUpdateNotice forkStable />);
    await waitFor(() => expect(getIdentifier).toHaveBeenCalledOnce());
    expect(check).not.toHaveBeenCalled();
    preview.unmount();

    getIdentifier.mockResolvedValue("io.github.flowforever.gitdesktop");
    check.mockResolvedValue({
      version: "0.15.1",
      downloadAndInstall: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    render(<PreviewUpdateNotice forkStable />);
    const dialog = await screen.findByRole("dialog", {
      name: "GitDesktop Flowforever update",
    });
    expect(
      within(dialog).getByText("GitDesktop Flowforever 0.15.1 is available."),
    ).toBeVisible();
    expect(check).toHaveBeenCalledOnce();
  });

  it("never checks in a browser", () => {
    isTauri.mockReturnValue(false);
    render(<PreviewUpdateNotice />);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks the separately identified staging app", async () => {
    isTauri.mockReturnValue(true);
    getIdentifier.mockResolvedValue("com.thebguy.gitdesktop.preview.staging");
    check.mockResolvedValue(null);
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("never checks a stable app even when mounted", async () => {
    isTauri.mockReturnValue(true);
    getIdentifier.mockResolvedValue("com.thebguy.gitdesktop");
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(getIdentifier).toHaveBeenCalledOnce());
    expect(check).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
  });

  it("ignores an unavailable feed without showing an install option", async () => {
    isTauri.mockReturnValue(true);
    check.mockRejectedValue(new Error("offline"));
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
