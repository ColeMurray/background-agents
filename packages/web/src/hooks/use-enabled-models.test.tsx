// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared/models";
import { MODEL_PREFERENCES_KEY, useEnabledModels } from "./use-enabled-models";

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
            [MODEL_PREFERENCES_KEY]: { enabledModels, revision: 1 },
          },
          revalidateIfStale: false,
        }}
      >
        {children}
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

  it("optimistically updates while a save is in flight", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((done) => (resolve = done))));
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: wrapper(["openai/gpt-5.4"]),
    });

    let update!: Promise<void>;
    act(() => {
      update = result.current.updateModels([
        { modelId: "anthropic/claude-haiku-4-5", enabled: true },
      ]);
    });
    expect(result.current.enabledModels).toEqual(["openai/gpt-5.4", "anthropic/claude-haiku-4-5"]);
    expect(result.current.saving).toBe(true);

    await act(async () => {
      resolve(
        Response.json({
          enabledModels: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"],
          revision: 2,
        })
      );
      await update;
    });
    expect(result.current.saving).toBe(false);
  });

  it("does not replace a newer snapshot with a delayed PATCH response", async () => {
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
        <SWRConfig value={{ provider: () => new Map(), fetcher }}>{children}</SWRConfig>
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
          {children}
        </SWRConfig>
      ),
    });
    await waitFor(() => expect(result.current.error).toBe(readError));
    await expect(
      result.current.updateModels([{ modelId: "openai/gpt-5.4", enabled: true }])
    ).rejects.toThrow("Model preferences must load before saving");
  });
});
