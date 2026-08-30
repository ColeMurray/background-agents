// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { useSessionCostSettings } from "./session-cost-settings-fields";

describe("useSessionCostSettings", () => {
  it("clears a scoped warning threshold back to inheritance", () => {
    const { result } = renderHook(() =>
      useSessionCostSettings(
        { costWarningThresholdPct: 75 },
        { costWarningThresholdPct: 80 },
        false
      )
    );

    act(() => result.current.setThreshold(""));
    const payload: SandboxSettings = {};
    result.current.apply(payload);

    expect(result.current.validate()).toBeNull();
    expect(payload).not.toHaveProperty("costWarningThresholdPct");
  });
});
