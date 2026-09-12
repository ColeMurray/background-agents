// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared/models";
import { useAuthSession } from "@/lib/auth-session";
import {
  AuthenticatedModelPreferencesProvider,
  MODEL_PREFERENCES_KEY,
  ModelPreferencesProvider,
  getModelPreferencesKey,
  useEnabledModels,
} from "./use-enabled-models";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function wrapper(enabledModels: unknown) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [getModelPreferencesKey("test-user")]: { enabledModels, revision: 1 },
          },
          revalidateIfStale: false,
        }}
      >
        <ModelPreferencesProvider identity="test-user">{children}</ModelPreferencesProvider>
      </SWRConfig>
    );
  };
}

describe("useEnabledModels", () => {
  it("normalizes and removes models that are no longer in the catalog", () => {
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: wrapper(["openai/gpt-5.2", "gpt-5.4", "openai/gpt-5.4"]),
    });
    expect(result.current.enabledModels).toEqual(["openai/gpt-5.4"]);
  });

  it("falls back to defaults when the response has no valid models", () => {
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: wrapper(["openai/gpt-5.2"]),
    });
    expect(result.current.enabledModels).toEqual(DEFAULT_ENABLED_MODELS);
  });

  it("stores the authoritative PATCH response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabledModels: ["anthropic/claude-sonnet-4-6"], revision: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: wrapper(["openai/gpt-5.4"]),
    });

    await act(async () => {
      await result.current.updateModels([{ modelId: "anthropic/claude-haiku-4-5", enabled: true }]);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      MODEL_PREFERENCES_KEY,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          changes: [{ modelId: "anthropic/claude-haiku-4-5", enabled: true }],
        }),
      })
    );
    expect(result.current.enabledModels).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(result.current.saving).toBe(false);
  });

  it("queues rapid changes while showing their combined optimistic result", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveSecond = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: wrapper(["openai/gpt-5.4"]),
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.updateModels([
        { modelId: "anthropic/claude-haiku-4-5", enabled: true },
      ]);
      second = result.current.updateModels([{ modelId: "openai/gpt-5.4", enabled: false }]);
    });
    expect(result.current.enabledModels).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(result.current.saving).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveFirst(
        Response.json({
          enabledModels: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"],
          revision: 2,
        })
      );
      await first;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond(Response.json({ enabledModels: ["anthropic/claude-haiku-4-5"], revision: 3 }));
      await second;
    });
    expect(result.current.enabledModels).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(result.current.saving).toBe(false);
  });

  it("cancels queued and in-flight work when the authenticated identity changes", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(
        Response.json({
          enabledModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
          revision: 2,
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(useAuthSession).mockReturnValue({
      status: "authenticated",
      data: { user: { id: "11111111111111111111111111111111" } },
    });
    const { result, rerender } = renderHook(() => useEnabledModels(), {
      wrapper: ({ children }) => (
        <SWRConfig
          value={{
            provider: () => new Map(),
            fallback: {
              [getModelPreferencesKey("11111111111111111111111111111111")]: {
                enabledModels: ["openai/gpt-5.4"],
                revision: 1,
              },
              [getModelPreferencesKey("22222222222222222222222222222222")]: {
                enabledModels: ["openai/gpt-5.4"],
                revision: 1,
              },
            },
            revalidateIfStale: false,
          }}
        >
          <AuthenticatedModelPreferencesProvider>{children}</AuthenticatedModelPreferencesProvider>
        </SWRConfig>
      ),
    });

    let first!: Promise<void>;
    let staleQueued!: Promise<void>;
    act(() => {
      first = result.current.updateModels([
        { modelId: "anthropic/claude-haiku-4-5", enabled: true },
      ]);
      staleQueued = result.current.updateModels([
        { modelId: "anthropic/claude-opus-4-6", enabled: true },
      ]);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    vi.mocked(useAuthSession).mockReturnValue({
      status: "authenticated",
      data: { user: { id: "22222222222222222222222222222222" } },
    });
    rerender();
    expect(fetchMock.mock.calls[0][1].signal).toHaveProperty("aborted", true);
    await act(async () => {
      resolveFirst(
        Response.json({
          enabledModels: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"],
          revision: 2,
        })
      );
      await Promise.all([first, staleQueued]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.enabledModels).toEqual(["openai/gpt-5.4"]);
    await act(async () => {
      await result.current.updateModels([
        { modelId: "anthropic/claude-sonnet-4-6", enabled: true },
      ]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not expose cached preferences from the previous identity", async () => {
    type Snapshot = { enabledModels: string[]; revision: number };
    let resolveFirst!: (snapshot: Snapshot) => void;
    let resolveSecond!: (snapshot: Snapshot) => void;
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(new Promise<Snapshot>((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise<Snapshot>((resolve) => (resolveSecond = resolve)));
    const cache = new Map();
    vi.mocked(useAuthSession).mockReturnValue({
      status: "authenticated",
      data: { user: { id: "11111111111111111111111111111111" } },
    });
    const { result, rerender } = renderHook(() => useEnabledModels(), {
      wrapper: ({ children }) => (
        <SWRConfig
          value={{ provider: () => cache, fetcher, dedupingInterval: 0, revalidateIfStale: false }}
        >
          <AuthenticatedModelPreferencesProvider>{children}</AuthenticatedModelPreferencesProvider>
        </SWRConfig>
      ),
    });

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        getModelPreferencesKey("11111111111111111111111111111111")
      )
    );
    await act(async () => {
      resolveFirst({ enabledModels: ["openai/gpt-5.4"], revision: 1 });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(useAuthSession).mockReturnValue({
      status: "authenticated",
      data: { user: { id: "22222222222222222222222222222222" } },
    });
    rerender();

    expect(result.current.loading).toBe(true);
    expect(result.current.enabledModels).toEqual([]);
    await expect(
      result.current.updateModels([{ modelId: "anthropic/claude-haiku-4-5", enabled: true }])
    ).rejects.toThrow("Model preferences must load before saving");
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        getModelPreferencesKey("22222222222222222222222222222222")
      )
    );
    await act(async () => {
      resolveSecond({ enabledModels: ["anthropic/claude-sonnet-4-6"], revision: 1 });
    });
    await waitFor(() =>
      expect(result.current.enabledModels).toEqual(["anthropic/claude-sonnet-4-6"])
    );
  });

  it("cancels queued work when the provider unmounts", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFirst = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useEnabledModels(), {
      wrapper: wrapper(["openai/gpt-5.4"]),
    });

    let first!: Promise<void>;
    let queued!: Promise<void>;
    act(() => {
      first = result.current.updateModels([
        { modelId: "anthropic/claude-haiku-4-5", enabled: true },
      ]);
      queued = result.current.updateModels([
        { modelId: "anthropic/claude-sonnet-4-6", enabled: true },
      ]);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();
    expect(fetchMock.mock.calls[0][1].signal).toHaveProperty("aborted", true);
    await act(async () => {
      resolveFirst(Response.json({ enabledModels: ["anthropic/claude-haiku-4-5"], revision: 2 }));
      await Promise.all([first, queued]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replace a newer GET snapshot with a delayed PATCH response", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((done) => (resolve = done))));
    const { result } = renderHook(
      () => ({ preferences: useEnabledModels(), mutate: useSWRConfig().mutate }),
      { wrapper: wrapper(["openai/gpt-5.4"]) }
    );

    let update!: Promise<void>;
    act(() => {
      update = result.current.preferences.updateModels([
        { modelId: "anthropic/claude-haiku-4-5", enabled: true },
      ]);
    });
    await act(async () => {
      await result.current.mutate(
        getModelPreferencesKey("test-user"),
        {
          enabledModels: [
            "openai/gpt-5.4",
            "anthropic/claude-haiku-4-5",
            "anthropic/claude-sonnet-4-6",
          ],
          revision: 3,
        },
        { revalidate: false }
      );
    });
    expect(result.current.preferences.enabledModels).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
    ]);

    await act(async () => {
      resolve(
        Response.json({
          enabledModels: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"],
          revision: 2,
        })
      );
      await update;
    });
    expect(result.current.preferences.enabledModels).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("reconciles a failed request before continuing queued changes", async () => {
    const fetcher = vi.fn(async () => ({ enabledModels: ["openai/gpt-5.4"], revision: 1 }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Save denied" }, { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({
          enabledModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
          revision: 2,
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: ({ children }) => (
        <SWRConfig
          value={{
            provider: () => new Map(),
            fallback: {
              [getModelPreferencesKey("test-user")]: {
                enabledModels: ["openai/gpt-5.4"],
                revision: 1,
              },
            },
            fetcher,
            revalidateIfStale: false,
          }}
        >
          <ModelPreferencesProvider identity="test-user">{children}</ModelPreferencesProvider>
        </SWRConfig>
      ),
    });

    let failed!: Promise<void>;
    let queued!: Promise<void>;
    act(() => {
      failed = result.current.updateModels([
        { modelId: "anthropic/claude-haiku-4-5", enabled: true },
      ]);
      void failed.catch(() => undefined);
      queued = result.current.updateModels([
        { modelId: "anthropic/claude-sonnet-4-6", enabled: true },
      ]);
    });
    expect(result.current.enabledModels).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
    ]);

    await act(async () => {
      await expect(failed).rejects.toThrow("Save denied");
      await queued;
    });
    expect(fetcher).toHaveBeenCalledWith(getModelPreferencesKey("test-user"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.enabledModels).toEqual(["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]);
  });

  it("rejects a queued change that becomes invalid after an earlier failure", async () => {
    const fetcher = vi.fn(async () => ({ enabledModels: ["openai/gpt-5.4"], revision: 1 }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Save denied" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const renderedModels: string[][] = [];
    const { result } = renderHook(
      () => {
        const preferences = useEnabledModels();
        renderedModels.push(preferences.enabledModels);
        return preferences;
      },
      {
        wrapper: ({ children }) => (
          <SWRConfig
            value={{
              provider: () => new Map(),
              fallback: {
                [getModelPreferencesKey("test-user")]: {
                  enabledModels: ["openai/gpt-5.4"],
                  revision: 1,
                },
              },
              fetcher,
              revalidateIfStale: false,
            }}
          >
            <ModelPreferencesProvider identity="test-user">{children}</ModelPreferencesProvider>
          </SWRConfig>
        ),
      }
    );

    let failed!: Promise<void>;
    let dependent!: Promise<void>;
    act(() => {
      failed = result.current.updateModels([
        { modelId: "anthropic/claude-haiku-4-5", enabled: true },
      ]);
      void failed.catch(() => undefined);
      dependent = result.current.updateModels([{ modelId: "openai/gpt-5.4", enabled: false }]);
      void dependent.catch(() => undefined);
    });

    await act(async () => {
      await expect(failed).rejects.toThrow("Save denied");
      await expect(dependent).rejects.toThrow("At least one model must be enabled");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.enabledModels).toEqual(["openai/gpt-5.4"]);
    expect(renderedModels).not.toContainEqual([]);
  });

  it.each([
    null,
    {},
    { enabledModels: [] },
    { enabledModels: [42] },
    { enabledModels: ["unknown/model"] },
  ])("rejects an invalid PATCH response and rolls back: %j", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: wrapper(["openai/gpt-5.4"]),
    });
    await act(async () => {
      await expect(
        result.current.updateModels([{ modelId: "anthropic/claude-haiku-4-5", enabled: true }])
      ).rejects.toThrow("Invalid model preferences response");
    });
    expect(result.current.enabledModels).toEqual(["openai/gpt-5.4"]);
    expect(result.current.saving).toBe(false);
  });

  it("only dispatches the model preferences resource through the global fetcher", async () => {
    const fetcher = vi.fn(async (_key: string) => ({
      enabledModels: ["openai/gpt-5.4"],
      revision: 1,
    }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ enabledModels: ["anthropic/claude-haiku-4-5"], revision: 2 })
        )
    );
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: ({ children }) => (
        <SWRConfig value={{ provider: () => new Map(), fetcher }}>
          <ModelPreferencesProvider identity="test-user">{children}</ModelPreferencesProvider>
        </SWRConfig>
      ),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.updateModels([{ modelId: "anthropic/claude-haiku-4-5", enabled: true }]);
    });
    expect(fetcher.mock.calls.map(([key]) => key)).toEqual([getModelPreferencesKey("test-user")]);
  });

  it("exposes read errors and rejects writes before preferences have loaded", async () => {
    const readError = new Error("Read failed");
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: ({ children }) => (
        <SWRConfig
          value={{
            provider: () => new Map(),
            fetcher: async () => {
              throw readError;
            },
            shouldRetryOnError: false,
          }}
        >
          <ModelPreferencesProvider identity="test-user">{children}</ModelPreferencesProvider>
        </SWRConfig>
      ),
    });
    await waitFor(() => expect(result.current.error).toBe(readError));
    await expect(
      result.current.updateModels([{ modelId: "openai/gpt-5.4", enabled: true }])
    ).rejects.toThrow("Model preferences must load before saving");
  });
});
