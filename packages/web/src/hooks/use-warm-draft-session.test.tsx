// @vitest-environment jsdom

import { useLayoutEffect } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { retireWarmDraftSession } from "@/lib/warm-session";
import {
  useWarmDraftSession,
  warmDraftSessionIdentity,
  type WarmDraftSessionRequest,
} from "./use-warm-draft-session";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/warm-session", () => ({ retireWarmDraftSession: vi.fn() }));

const request = (model = "openai/gpt-5.4"): WarmDraftSessionRequest => ({
  repoOwner: "open-inspect",
  repoName: "background-agents",
  model,
  skillSelection: { mode: "all" },
  providerSelections: {
    openai: { mode: "provider_account", accountId: "a".repeat(32) },
    xai: { mode: "api_key" },
  },
});

describe("useWarmDraftSession", () => {
  beforeEach(() => vi.resetAllMocks());

  it("derives one stable identity from the complete launch request", () => {
    expect(warmDraftSessionIdentity(request())).toBe(
      warmDraftSessionIdentity({
        providerSelections: {
          xai: { mode: "api_key" },
          openai: { accountId: "a".repeat(32), mode: "provider_account" },
        },
        skillSelection: { mode: "all" },
        model: "openai/gpt-5.4",
        repoName: "background-agents",
        repoOwner: "open-inspect",
      })
    );
  });

  it("retires a completed draft when any launch input changes", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ sessionId: "session-1", status: "created" })
    );
    const { result, rerender } = renderHook(
      ({ launchRequest }) => useWarmDraftSession(launchRequest),
      { initialProps: { launchRequest: request() } }
    );

    await act(async () => {
      await result.current.warm();
    });
    expect(result.current.sessionId).toBe("session-1");

    rerender({ launchRequest: request("openai/gpt-5.5") });
    await waitFor(() => expect(retireWarmDraftSession).toHaveBeenCalledWith("session-1"));
    expect(result.current.sessionId).toBeNull();
  });

  it("warms the current request when called from a layout effect after an input change", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ sessionId: "session-2", status: "created" })
    );
    let warming: Promise<string | null> | undefined;
    const { rerender } = renderHook(
      ({ launchRequest, warmInLayout }) => {
        const draft = useWarmDraftSession(launchRequest);
        const { warm } = draft;
        useLayoutEffect(() => {
          if (warmInLayout) warming = warm();
        }, [warm, warmInLayout]);
        return draft;
      },
      { initialProps: { launchRequest: request(), warmInLayout: false } }
    );

    rerender({ launchRequest: request("openai/gpt-5.5"), warmInLayout: true });
    await act(async () => {
      await warming;
    });

    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ body: JSON.stringify(request("openai/gpt-5.5")) })
    );
    await expect(warming).resolves.toBe("session-2");
  });

  it("retires a stale response even when the aborted request still settles", async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    vi.mocked(browserApiFetch).mockImplementation(
      () => new Promise<Response>((resolve) => (resolveCreate = resolve))
    );
    const { result, rerender } = renderHook(
      ({ launchRequest }) => useWarmDraftSession(launchRequest),
      { initialProps: { launchRequest: request() } }
    );

    let warming: Promise<string | null> | undefined;
    act(() => {
      warming = result.current.warm();
    });
    rerender({ launchRequest: request("openai/gpt-5.5") });
    resolveCreate?.(Response.json({ sessionId: "stale-session", status: "created" }));

    await act(async () => {
      await warming;
    });
    expect(retireWarmDraftSession).toHaveBeenCalledWith("stale-session");
    expect(result.current.sessionId).toBeNull();
  });

  it("retires a response that settles after unmount", async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    vi.mocked(browserApiFetch).mockImplementation(
      () => new Promise<Response>((resolve) => (resolveCreate = resolve))
    );
    const { result, unmount } = renderHook(() => useWarmDraftSession(request()));

    let warming: Promise<string | null> | undefined;
    act(() => {
      warming = result.current.warm();
    });
    unmount();
    resolveCreate?.(Response.json({ sessionId: "orphaned-session", status: "created" }));

    await act(async () => {
      await warming;
    });
    expect(retireWarmDraftSession).toHaveBeenCalledWith("orphaned-session");
  });
});
