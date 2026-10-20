// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  sessionExternalActionsKey,
  useSessionExternalActions,
} from "./use-session-external-actions";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const pending = {
  id: "action-1",
  provider: "github",
  action: "comment",
  summary: "Comment on issue 12",
  state: "awaiting_approval" as const,
  target: { owner: "acme", repo: "widgets", issue: 12 },
  arguments: { body: "hello" },
  approval: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

describe("useSessionExternalActions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses the session-scoped pending list key", () => {
    expect(sessionExternalActionsKey("session-1")).toBe("/api/sessions/session-1/external-actions");
  });

  it("loads the pending list the control plane owns", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ actions: [pending], nextCursor: null })
    );
    const { result } = renderHook(() => useSessionExternalActions("session-1", true), { wrapper });

    await waitFor(() => expect(result.current.actions).toHaveLength(1));
    expect(result.current.actions[0]).toMatchObject({ id: "action-1", provider: "github" });
    expect(browserApiFetch).toHaveBeenCalledWith("/api/sessions/session-1/external-actions");
  });

  it("does not request anything while the capability is disabled", async () => {
    const { result } = renderHook(() => useSessionExternalActions("session-1", false), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("posts a decision and refreshes the list", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ actions: [pending], nextCursor: null }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ actions: [], nextCursor: null }));
    const { result } = renderHook(() => useSessionExternalActions("session-1", true), { wrapper });

    await waitFor(() => expect(result.current.actions).toHaveLength(1));
    await act(async () => {
      await result.current.decide("action-1", "approve");
    });

    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/sessions/session-1/external-actions/action-1/decision",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("surfaces a refused decision instead of pretending it succeeded", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ actions: [pending], nextCursor: null }))
      .mockResolvedValueOnce(
        Response.json({ error: "Forbidden", code: "session_action_denied" }, { status: 403 })
      );
    const { result } = renderHook(() => useSessionExternalActions("session-1", true), { wrapper });

    await waitFor(() => expect(result.current.actions).toHaveLength(1));
    await act(async () => {
      await expect(result.current.decide("action-1", "approve")).rejects.toThrow();
    });
  });
});
