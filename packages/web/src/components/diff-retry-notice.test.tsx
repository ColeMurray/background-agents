// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffRetryNotice } from "./diff-retry-notice";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DiffRetryNotice", () => {
  it("retries through the explicit retry endpoint from the banner variant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiffRetryNotice sessionId="session-1" message="timed out" variant="banner" />);

    expect(screen.getByText("timed out")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/diff/retry", {
      method: "POST",
    });
  });

  it("announces an authoritative retry failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Sandbox is not connected" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiffRetryNotice sessionId="session-1" message="timed out" variant="banner" />);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sandbox is not connected");
  });

  it("renders the inline variant with the same retry action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Still failing" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiffRetryNotice sessionId="session-2" message="capture failed" variant="inline" />);

    expect(screen.getByText("capture failed")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-2/diff/retry", {
      method: "POST",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Still failing");
  });
});
