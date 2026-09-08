// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared";
import { MODEL_PREFERENCES_KEY, useEnabledModels } from "./use-enabled-models";

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
});
