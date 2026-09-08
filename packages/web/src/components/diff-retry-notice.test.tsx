// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffRetryNotice } from "./diff-retry-notice";
import type { SessionCapabilities } from "@/lib/session-capabilities";

const FULL_CAPABILITIES = {
  read: true,
  collaborate: true,
  lifecycle: true,
  sandboxAccess: true,
} satisfies SessionCapabilities;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DiffRetryNotice", () => {
  it("retries through the explicit retry endpoint from the banner variant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DiffRetryNotice
        sessionId="session-1"
        message="timed out"
        variant="banner"
        capabilities={FULL_CAPABILITIES}
      />
    );

    expect(screen.getByText("timed out")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/diff/retry", {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
    });
  });

  it("announces an authoritative retry failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Sandbox is not connected" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DiffRetryNotice
        sessionId="session-1"
        message="timed out"
        variant="banner"
        capabilities={FULL_CAPABILITIES}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sandbox is not connected");
  });

  it("renders the inline variant with the same retry action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Still failing" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DiffRetryNotice
        sessionId="session-2"
        message="capture failed"
        variant="inline"
        capabilities={FULL_CAPABILITIES}
      />
    );

    expect(screen.getByText("capture failed")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-2/diff/retry", {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Still failing");
  });

  it("hides retry without lifecycle permission even when collaboration is allowed", () => {
    render(
      <DiffRetryNotice
        sessionId="session-1"
        message="timed out"
        variant="banner"
        capabilities={{ ...FULL_CAPABILITIES, lifecycle: false }}
      />
    );

    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
