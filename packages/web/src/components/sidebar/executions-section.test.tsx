// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionsSection } from "./executions-section";

const cancel = vi.fn(async () => undefined);
const output = vi.fn(async () => ({
  chunks: [{ sequence: 0, stream: "stdout" as const, data: "tests passed\n", createdAt: 1 }],
  nextSequence: null,
}));

vi.mock("@/hooks/use-session-executions", () => ({
  useSessionExecutions: () => ({
    commands: [
      {
        id: "cmd-1",
        operationId: "operation-1",
        purpose: "test",
        state: "running",
        actor: { kind: "user", id: "user-1" },
        approvalRevision: 1,
        outputBytes: 12,
        outputTruncated: false,
        exitCode: null,
        signal: null,
        error: null,
        createdAt: 1,
        startedAt: 2,
        completedAt: null,
        replayGap: false,
      },
    ],
    error: null,
    isLoading: false,
    cancel,
    output,
  }),
}));

const capabilities = {
  read: true,
  collaborate: true,
  lifecycle: false,
  delete: false,
  manageCollaborators: false,
  changeVisibility: false,
  sandboxAccess: false,
  exportTrace: false,
};

describe("ExecutionsSection", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("explains isolation and exposes authorized status, output, and cancellation", async () => {
    render(<ExecutionsSection sessionId="session-1" capabilities={capabilities} />);

    expect(screen.getByText(/dedicated isolated sandbox/i)).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View output" }));
    expect(await screen.findByText(/tests passed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("cmd-1"));
  });

  it("does not expose cancellation without collaboration authority", () => {
    render(
      <ExecutionsSection
        sessionId="session-1"
        capabilities={{ ...capabilities, collaborate: false }}
      />
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
