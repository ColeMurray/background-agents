// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotRetryButton } from "./snapshot-retry-button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SnapshotRetryButton", () => {
  it("prevents a second retry while the request is pending", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SnapshotRetryButton sessionId="session-1" disabled={false} />);

    const retry = screen.getByRole("button", { name: "Retry the existing snapshot" });
    await user.click(retry);

    expect(screen.getByRole("button", { name: "Retrying snapshot…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retrying snapshot…" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(Response.json({ started: true }, { status: 202 }));
    await waitFor(() => expect(retry).toBeEnabled());
  });

  it("clears pending state after a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 409 })));
    vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<SnapshotRetryButton sessionId="session-1" disabled={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Retry the existing snapshot" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry the existing snapshot" })).toBeEnabled()
    );
    expect(window.alert).toHaveBeenCalledOnce();
  });

  it("preserves an external spawning or connecting guard", () => {
    render(<SnapshotRetryButton sessionId="session-1" disabled />);

    expect(screen.getByRole("button", { name: "Retry the existing snapshot" })).toBeDisabled();
  });
});
