// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDiffState } from "@open-inspect/shared";

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="diff-renderer" />,
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

import { SessionChangesPanel } from "./session-changes-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const state: SessionDiffState = {
  version: 1,
  baseline: { status: "ready", reason: null },
  attempt: { id: null, status: "idle", startedAt: null, error: null },
  current: {
    revisionId: "capture-1",
    capturedAt: 100,
    triggerMessageId: "message-1",
    repositories: [
      {
        position: 0,
        repoOwner: "acme",
        repoName: "web",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        capturedAt: 100,
        status: "stale",
        sourceCaptureId: "capture-1",
        truncated: true,
        omittedFileCount: 2,
        error: "latest capture failed",
        files: [
          {
            id: "file-1",
            path: "src/app.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            renderState: "metadata_only",
            oldMode: "100644",
            newMode: "100755",
          },
          {
            id: "file-2",
            path: "src/lib.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            renderState: "metadata_only",
          },
        ],
      },
    ],
  },
};

describe("SessionChangesPanel", () => {
  it("keeps searchable file navigation and selected-file context in the panel", async () => {
    const onSelect = vi.fn();
    render(
      <SessionChangesPanel
        sessionId="session-1"
        state={state}
        resolved={{
          status: "ready",
          revisionId: "capture-1",
          repository: state.current!.repositories[0]!,
          file: state.current!.repositories[0]!.files[0]!,
        }}
        onClose={vi.fn()}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText("acme/web")).toBeVisible();
    expect(screen.getByText(/modified.*\+2.*-1/i)).toBeVisible();
    expect(screen.getByText("Compared with session start")).toBeVisible();
    expect(screen.getByText(/latest capture failed/i)).toBeVisible();
    expect(screen.getByText(/2 additional files omitted/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /lib\.ts.*modified/i }));
    expect(onSelect).toHaveBeenCalledWith({ repositoryPosition: 0, path: "src/lib.ts" });
  });

  it("keeps navigation available when a selected file disappears", () => {
    render(
      <SessionChangesPanel
        sessionId="session-1"
        state={state}
        resolved={{ status: "missing", revisionId: "capture-1" }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole("searchbox", { name: "Filter changed files" })).toBeVisible();
    expect(screen.getByRole("button", { name: /app\.ts.*modified/i })).toBeVisible();
    expect(screen.getByText(/no longer part of the latest/i)).toBeVisible();
  });

  it("forces a unified-only diff control on mobile", () => {
    render(
      <SessionChangesPanel
        mobile
        sessionId="session-1"
        state={state}
        resolved={{
          status: "ready",
          revisionId: "capture-1",
          repository: state.current!.repositories[0]!,
          file: state.current!.repositories[0]!.files[0]!,
        }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Unified" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Split" })).not.toBeInTheDocument();
  });

  it("reports an authoritative retry failure from the explicit retry endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Sandbox is not connected" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SessionChangesPanel
        sessionId="session-1"
        state={{
          ...state,
          attempt: { id: "capture-2", status: "failed", startedAt: 200, error: "timed out" },
        }}
        resolved={{
          status: "ready",
          revisionId: "capture-1",
          repository: state.current!.repositories[0]!,
          file: state.current!.repositories[0]!.files[0]!,
        }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/diff/retry", {
      method: "POST",
    });
    expect(await screen.findByText("Sandbox is not connected")).toBeVisible();
  });
});
