// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared/models";
import {
  MODEL_PREFERENCES_KEY,
  ModelPreferencesProvider,
  useEnabledModels,
} from "./use-enabled-models";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrapper(enabledModels: unknown) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: { [MODEL_PREFERENCES_KEY]: { enabledModels } },
          revalidateIfStale: false,
        }}
      >
        <ModelPreferencesProvider>{children}</ModelPreferencesProvider>
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
      json: async () => ({ enabledModels: ["anthropic/claude-sonnet-4-6"] }),
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
        })
      );
      await first;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond(Response.json({ enabledModels: ["anthropic/claude-haiku-4-5"] }));
      await second;
    });
    expect(result.current.enabledModels).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(result.current.saving).toBe(false);
  });

  it("reapplies pending changes over an external cache refresh", async () => {
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
        MODEL_PREFERENCES_KEY,
        { enabledModels: ["anthropic/claude-sonnet-4-6"] },
        { revalidate: false }
      );
    });
    expect(result.current.preferences.enabledModels).toEqual([
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
    ]);

    await act(async () => {
      resolve(
        Response.json({
          enabledModels: ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"],
        })
      );
      await update;
    });
  });

  it("reconciles a failed request before continuing queued changes", async () => {
    const fetcher = vi.fn(async () => ({ enabledModels: ["openai/gpt-5.4"] }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Save denied" }, { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({
          enabledModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: ({ children }) => (
        <SWRConfig
          value={{
            provider: () => new Map(),
            fallback: { [MODEL_PREFERENCES_KEY]: { enabledModels: ["openai/gpt-5.4"] } },
            fetcher,
            revalidateIfStale: false,
          }}
        >
          <ModelPreferencesProvider>{children}</ModelPreferencesProvider>
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
    expect(fetcher).toHaveBeenCalledWith(MODEL_PREFERENCES_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.enabledModels).toEqual(["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]);
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
    const fetcher = vi.fn(async (_key: string) => ({ enabledModels: ["openai/gpt-5.4"] }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ enabledModels: ["anthropic/claude-haiku-4-5"] }))
    );
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: ({ children }) => (
        <SWRConfig value={{ provider: () => new Map(), fetcher }}>
          <ModelPreferencesProvider>{children}</ModelPreferencesProvider>
        </SWRConfig>
      ),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.updateModels([{ modelId: "anthropic/claude-haiku-4-5", enabled: true }]);
    });
    expect(fetcher.mock.calls.map(([key]) => key)).toEqual([MODEL_PREFERENCES_KEY]);
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
          <ModelPreferencesProvider>{children}</ModelPreferencesProvider>
        </SWRConfig>
      ),
    });
    await waitFor(() => expect(result.current.error).toBe(readError));
    await expect(
      result.current.updateModels([{ modelId: "openai/gpt-5.4", enabled: true }])
    ).rejects.toThrow("Model preferences must load before saving");
  });
});
