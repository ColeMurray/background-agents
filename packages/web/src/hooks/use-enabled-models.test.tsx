// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared/models";
import { MODEL_PREFERENCES_KEY, useEnabledModels } from "./use-enabled-models";

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

  it("stores the authoritative PUT response instead of the submitted selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "updated", enabledModels: ["anthropic/claude-sonnet-4-6"] }),
      })
    );
    const { result } = renderHook(() => useEnabledModels(), {
      wrapper: wrapper(["openai/gpt-5.4"]),
    });
    await act(async () => {
      await result.current.saveEnabledModels(["openai/gpt-5.4", "anthropic/claude-haiku-4-5"]);
    });
    expect(result.current.enabledModels).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(result.current.saving).toBe(false);
  });

  it.each([null, {}, { enabledModels: [] }, { enabledModels: [42] }])(
    "rejects an invalid PUT response and rolls back: %j",
    async (response) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
      const { result } = renderHook(() => useEnabledModels(), {
        wrapper: wrapper(["openai/gpt-5.4"]),
      });
      await act(async () => {
        await expect(
          result.current.saveEnabledModels(["anthropic/claude-haiku-4-5"])
        ).rejects.toThrow("Invalid model preferences response");
      });
      expect(result.current.enabledModels).toEqual(["openai/gpt-5.4"]);
      expect(result.current.saving).toBe(false);
    }
  );

  it("exposes read errors and rejects writes before preferences have loaded", async () => {
    const readError = new Error("Read failed");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
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
    await expect(result.current.saveEnabledModels(["openai/gpt-5.4"])).rejects.toThrow(
      "Model preferences must load before saving"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
