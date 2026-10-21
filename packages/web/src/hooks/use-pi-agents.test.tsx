// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

import { browserApiFetch } from "@/lib/browser-api-fetch";
import { usePiAgents } from "./use-pi-agents";

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

describe("usePiAgents", () => {
  beforeEach(() => vi.resetAllMocks());

  it("does not fetch when Pi controls are disabled", () => {
    renderHook(() => usePiAgents("session-1", false), { wrapper });
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("loads through SWR and refreshes after an explicit action", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(
        Response.json({
          state: "completed",
          result: {
            agents: [
              {
                conversationId: 1,
                status: "idle",
                queued: 0,
                tasks: [],
                usage: {
                  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  costUsd: 0,
                },
                lastEntryId: null,
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ state: "accepted" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ state: "completed", result: { agents: [] } }));
    const { result } = renderHook(() => usePiAgents("session-1", true), { wrapper });
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    await result.current.run({ action: "send", conversationId: 1, content: "check tests" });
    expect(browserApiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/session-1/pi/control",
      expect.objectContaining({ method: "POST" })
    );
    await waitFor(() => expect(result.current.agents).toEqual([]));
  });

  it("routes the agent's lifecycle actions to the lifecycle route", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ state: "completed", result: { agents: [] } }))
      .mockResolvedValueOnce(Response.json({ state: "accepted" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ state: "completed", result: { agents: [] } }));
    const { result } = renderHook(() => usePiAgents("session-1", true), { wrapper });
    await waitFor(() => expect(browserApiFetch).toHaveBeenCalledTimes(1));

    await result.current.run({ action: "fork", conversationId: 1, entryId: 2 });

    expect(browserApiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/session-1/pi/lifecycle-control",
      expect.objectContaining({ method: "POST" })
    );
  });
});
