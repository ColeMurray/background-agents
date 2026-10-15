// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { toast } from "sonner";
import { MarkAllReadButton } from "./mark-all-read-button";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openConfirmation() {
  fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
}

describe("MarkAllReadButton", () => {
  it("does nothing when the confirmation is cancelled", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(<MarkAllReadButton count={3} onConfirm={onConfirm} />);

    openConfirmation();
    expect(await screen.findByText("Mark 3 sessions as read?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText("Mark 3 sessions as read?")).not.toBeInTheDocument()
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open and reports a failed request", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<MarkAllReadButton count={2} scopeLabel="Platform" onConfirm={onConfirm} />);

    openConfirmation();
    expect(await screen.findByText("Platform")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't mark sessions as read"));
    expect(screen.getByText("Mark 2 sessions as read?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark read" })).toBeEnabled();
  });
});
