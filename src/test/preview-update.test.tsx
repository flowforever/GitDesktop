// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      name: "Download and install",
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

  it("opens a verified DMG on macOS only after consent, leaving installation to the user", async () => {
    platform.isMac = true;
    isTauri.mockReturnValue(true);
    invoke.mockResolvedValue(undefined);
    const downloadAndInstall = vi.fn();
    check.mockResolvedValue({
      version: "1.0.2",
      downloadAndInstall,
      close: vi.fn().mockResolvedValue(undefined),
    });
    render(<PreviewUpdateNotice />);
    const open = await screen.findByRole("button", {
      name: "Download and open disk image",
    });
    expect(invoke).not.toHaveBeenCalled();
    await userEvent.setup().click(open);
    expect(invoke).toHaveBeenCalledWith("preview_open_signed_dmg", {
      expectedVersion: "1.0.2",
    });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(await screen.findByText(/not Apple-notarized/)).toBeVisible();
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
      await screen.findByRole("button", { name: "Download and install" }),
    );
    expect(await screen.findByText(/could not be installed/)).toBeVisible();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
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
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never checks a stable app even when mounted", async () => {
    isTauri.mockReturnValue(true);
    getIdentifier.mockResolvedValue("com.thebguy.gitdesktop");
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(getIdentifier).toHaveBeenCalledOnce());
    expect(check).not.toHaveBeenCalled();
  });

  it("ignores an unavailable feed without showing an install option", async () => {
    isTauri.mockReturnValue(true);
    check.mockRejectedValue(new Error("offline"));
    render(<PreviewUpdateNotice />);
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });
});
