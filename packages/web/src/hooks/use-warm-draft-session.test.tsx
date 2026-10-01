// @vitest-environment jsdom

import { useLayoutEffect } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { retireWarmDraftSession } from "@/lib/warm-session";
import type { InteractiveProviderRoutingIdentity } from "@/lib/provider-selection";
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
  harness: "opencode",
  model,
  skillSelection: { mode: "all" },
  providerSelections: {
    openai: { mode: "provider_account", accountId: "a".repeat(32) },
    xai: { mode: "api_key" },
  },
  teamId: null,
  visibility: "workspace",
});

const routing = (
  xai: InteractiveProviderRoutingIdentity["xai"] = { mode: "legacy_scoped_oauth" }
): InteractiveProviderRoutingIdentity => ({
  openai: { mode: "legacy_scoped_oauth" },
  xai,
  anthropic: { mode: "legacy_scoped_oauth" },
});

describe("useWarmDraftSession", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    { teamId: "team-2", visibility: "team" as const },
    { teamId: "team-1", visibility: "private" as const },
  ])("retires and recreates a draft when team or visibility changes: %j", async (next) => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ sessionId: "old-session", status: "created" }))
      .mockResolvedValueOnce(Response.json({ sessionId: "new-session", status: "created" }));
    const initial: WarmDraftSessionRequest = {
      ...request(),
      teamId: "team-1",
      visibility: "team",
    };
    const { result, rerender } = renderHook(
      ({ launchRequest }) => useWarmDraftSession(launchRequest),
      { initialProps: { launchRequest: initial } }
    );

    await act(async () => {
      await result.current.warm();
    });
    rerender({ launchRequest: { ...initial, ...next } });
    expect(retireWarmDraftSession).toHaveBeenCalledWith("old-session");
    await act(async () => {
      await result.current.warm();
    });
    expect(result.current.sessionId).toBe("new-session");
    expect(browserApiFetch).toHaveBeenLastCalledWith(
      "/api/sessions",
      expect.objectContaining({ body: JSON.stringify({ ...initial, ...next }) })
    );
  });

  it.each([400, 403, 404, 409])(
    "surfaces a terminal %i denial without retrying the same draft",
    async (status) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ error: "Team unavailable", code: "team_archived" }, { status })
      );
      const { result, rerender } = renderHook(
        ({ launchRequest }) => useWarmDraftSession(launchRequest),
        { initialProps: { launchRequest: request() } }
      );

      await act(async () => {
        await result.current.warm();
      });
      expect(result.current.error).toEqual({
        message: "Team unavailable (team_archived)",
        code: "team_archived",
        status,
        terminal: true,
      });
      await act(async () => {
        await result.current.warm();
      });
      expect(browserApiFetch).toHaveBeenCalledTimes(1);

      rerender({ launchRequest: request("openai/gpt-5.5") });
      expect(result.current.error).toBeNull();
      await act(async () => {
        await result.current.warm();
      });
      expect(browserApiFetch).toHaveBeenCalledTimes(2);
    }
  );

  it.each([429, 500, 503])("preserves retries after a %i failure", async (status) => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ error: "Try again" }, { status }))
      .mockResolvedValueOnce(Response.json({ sessionId: "retried-session", status: "created" }));
    const { result } = renderHook(() => useWarmDraftSession(request()));

    await act(async () => {
      await result.current.warm();
    });
    expect(result.current.error?.terminal).toBe(false);
    await act(async () => {
      await result.current.warm();
    });
    expect(result.current.sessionId).toBe("retried-session");
    expect(result.current.error).toBeNull();
  });

  it("retries the unchanged draft explicitly after a missing repository grant is restored", async () => {
    let resolveRetry: ((response: Response) => void) | undefined;
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "Target team lacks repository grant",
            code: "target_team_missing_grant",
            repository: "group/subgroup/api",
          },
          { status: 409 }
        )
      )
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveRetry = resolve)));
    const initial: WarmDraftSessionRequest = {
      ...request(),
      repoOwner: "group/subgroup",
      repoName: "api",
      teamId: "team-1",
      visibility: "team",
    };
    const { result, rerender } = renderHook(
      ({ launchRequest }) => useWarmDraftSession(launchRequest),
      { initialProps: { launchRequest: initial } }
    );
    const identity = result.current.identity;
    await act(async () => {
      await expect(result.current.warm()).resolves.toBeNull();
    });
    expect(result.current.error).toEqual({
      message:
        "This team has no repository grant for group/subgroup/api. (target_team_missing_grant)",
      code: "target_team_missing_grant",
      status: 409,
      terminal: false,
    });
    expect(result.current.sessionId).toBeNull();
    expect(result.current.isWarming).toBe(false);

    rerender({ launchRequest: { ...initial } });
    expect(result.current.identity).toBe(identity);
    expect(result.current.error?.code).toBe("target_team_missing_grant");
    expect(browserApiFetch).toHaveBeenCalledOnce();

    let retries: Promise<string | null>[] = [];
    act(() => {
      retries = [result.current.warm(), result.current.warm(), result.current.warm()];
    });
    expect(result.current.isWarming).toBe(true);
    expect(result.current.error).toBeNull();
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(browserApiFetch).mock.calls.map(([, options]) => options?.body)).toEqual([
      JSON.stringify(initial),
      JSON.stringify(initial),
    ]);

    resolveRetry?.(Response.json({ sessionId: "retried-session", status: "created" }));
    await act(async () => {
      await expect(Promise.all(retries)).resolves.toEqual([
        "retried-session",
        "retried-session",
        "retried-session",
      ]);
    });
    expect(result.current.identity).toBe(identity);
    expect(result.current.sessionId).toBe("retried-session");
    expect(result.current.isWarming).toBe(false);
    expect(result.current.error).toBeNull();
    await act(async () => {
      await expect(result.current.warm()).resolves.toBe("retried-session");
    });
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    expect(retireWarmDraftSession).not.toHaveBeenCalled();
  });

  it("does not retry a still-missing grant on timers or same-identity renders", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(browserApiFetch).mockImplementation(async () =>
        Response.json(
          { error: "Target team lacks repository grant", code: "target_team_missing_grant" },
          { status: 409 }
        )
      );
      const initial = { ...request(), teamId: "team-1" };
      const { result, rerender } = renderHook(
        ({ launchRequest }) => useWarmDraftSession(launchRequest),
        { initialProps: { launchRequest: initial } }
      );

      for (const attempts of [1, 2]) {
        await act(async () => {
          await expect(result.current.warm()).resolves.toBeNull();
        });
        expect(result.current.error).toEqual({
          message: "Target team lacks repository grant (target_team_missing_grant)",
          code: "target_team_missing_grant",
          status: 409,
          terminal: false,
        });
        rerender({ launchRequest: { ...initial } });
        rerender({ launchRequest: { ...initial } });
        await act(async () => {
          await vi.runAllTimersAsync();
        });
        expect(browserApiFetch).toHaveBeenCalledTimes(attempts);
        expect(result.current.sessionId).toBeNull();
        expect(result.current.isWarming).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a terminal denial from a superseded request", async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    vi.mocked(browserApiFetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        })
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
    resolveCreate?.(
      Response.json({ error: "Forbidden", code: "not_team_member" }, { status: 403 })
    );
    await act(async () => {
      await warming;
    });
    expect(result.current.error).toBeNull();
  });

  it("derives one stable identity from the complete launch request", () => {
    expect(warmDraftSessionIdentity(request(), routing())).toBe(
      warmDraftSessionIdentity(
        {
          providerSelections: {
            xai: { mode: "api_key" },
            openai: { accountId: "a".repeat(32), mode: "provider_account" },
          },
          skillSelection: { mode: "all" },
          model: "openai/gpt-5.4",
          harness: "opencode",
          repoName: "background-agents",
          repoOwner: "open-inspect",
          teamId: null,
          visibility: "workspace",
        },
        routing()
      )
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

  it("rejects a malformed create-session response", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ sessionId: "session-1" }));
    const { result } = renderHook(() => useWarmDraftSession(request()));

    await act(async () => {
      await expect(result.current.warm()).resolves.toBeNull();
    });

    expect(result.current.sessionId).toBeNull();
  });

  it("retires a draft and warms the explicit provider account after authentication changes", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ sessionId: "legacy-session", status: "created" }))
      .mockResolvedValueOnce(Response.json({ sessionId: "account-session", status: "created" }));
    const initial = { ...request(), providerSelections: {} };
    const explicit = {
      ...initial,
      providerSelections: {
        xai: { mode: "provider_account" as const, accountId: "b".repeat(32) },
      },
    };
    const { result, rerender } = renderHook(
      ({ launchRequest }) => useWarmDraftSession(launchRequest),
      { initialProps: { launchRequest: initial } }
    );

    await act(async () => {
      await result.current.warm();
    });
    rerender({ launchRequest: explicit });
    await waitFor(() => expect(retireWarmDraftSession).toHaveBeenCalledWith("legacy-session"));
    await act(async () => {
      await result.current.warm();
    });

    expect(browserApiFetch).toHaveBeenLastCalledWith(
      "/api/sessions",
      expect.objectContaining({ body: JSON.stringify(explicit) })
    );
    expect(result.current.sessionId).toBe("account-session");
  });

  it("retires a draft when its effective provider account changes", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ sessionId: "default-session", status: "created" })
    );
    const initial = { ...request(), providerSelections: {} };
    const initialRouting = routing({
      mode: "provider_account",
      accountId: "a".repeat(32),
      status: "active",
      archivedAt: null,
    });
    const { result, rerender } = renderHook(
      ({ launchRequest, routingIdentity }) => useWarmDraftSession(launchRequest, routingIdentity),
      { initialProps: { launchRequest: initial, routingIdentity: initialRouting } }
    );

    await act(async () => {
      await result.current.warm();
    });
    rerender({
      launchRequest: initial,
      routingIdentity: routing({
        mode: "provider_account",
        accountId: "b".repeat(32),
        status: "active",
        archivedAt: null,
      }),
    });

    await waitFor(() => expect(retireWarmDraftSession).toHaveBeenCalledWith("default-session"));
    expect(result.current.sessionId).toBeNull();
  });

  it("retires a draft when the implicit default account becomes unavailable", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ sessionId: "active-default-session", status: "created" })
    );
    const initial = { ...request(), providerSelections: {} };
    const initialRouting = routing({
      mode: "provider_account",
      accountId: "a".repeat(32),
      status: "active",
      archivedAt: null,
    });
    const { result, rerender } = renderHook(
      ({ launchRequest, routingIdentity }) => useWarmDraftSession(launchRequest, routingIdentity),
      { initialProps: { launchRequest: initial, routingIdentity: initialRouting } }
    );

    await act(async () => {
      await result.current.warm();
    });
    rerender({
      launchRequest: initial,
      routingIdentity: routing({
        mode: "provider_account",
        accountId: "a".repeat(32),
        status: "reconnect_required",
        archivedAt: null,
      }),
    });

    await waitFor(() =>
      expect(retireWarmDraftSession).toHaveBeenCalledWith("active-default-session")
    );
    expect(result.current.sessionId).toBeNull();
  });

  it("retires a draft when an explicitly selected account becomes unavailable", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ sessionId: "explicit-account-session", status: "created" })
    );
    const accountId = "b".repeat(32);
    const initial: WarmDraftSessionRequest = {
      ...request(),
      providerSelections: { xai: { mode: "provider_account", accountId } },
    };
    const initialRouting = routing({
      mode: "provider_account",
      accountId,
      status: "active",
      archivedAt: null,
    });
    const { result, rerender } = renderHook(
      ({ launchRequest, routingIdentity }) => useWarmDraftSession(launchRequest, routingIdentity),
      { initialProps: { launchRequest: initial, routingIdentity: initialRouting } }
    );

    await act(async () => {
      await result.current.warm();
    });
    rerender({
      launchRequest: initial,
      routingIdentity: routing({
        mode: "provider_account",
        accountId,
        status: "reconnect_required",
        archivedAt: null,
      }),
    });

    await waitFor(() =>
      expect(retireWarmDraftSession).toHaveBeenCalledWith("explicit-account-session")
    );
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

  it.each([
    { sessionId: { id: "unsafe" }, status: "created" },
    { sessionId: "missing-status" },
    { sessionId: "invalid-status", status: "warming" },
  ])("ignores malformed create-session responses: %j", async (payload) => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json(payload));
    const { result } = renderHook(() => useWarmDraftSession(request()));

    await expect(result.current.warm()).resolves.toBeNull();
    expect(retireWarmDraftSession).not.toHaveBeenCalled();
    expect(result.current.sessionId).toBeNull();
  });
});
