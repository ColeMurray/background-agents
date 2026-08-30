// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { SessionCostSettingsFields, useSessionCostSettings } from "./session-cost-settings-fields";

describe("useSessionCostSettings", () => {
  it("describes blank scoped limits as inherited", () => {
    render(
      <SessionCostSettingsFields
        isGlobal={false}
        maxSessionCostUsd=""
        costWarningThresholdPct=""
        onMaxSessionCostUsdChange={() => undefined}
        onCostWarningThresholdPctChange={() => undefined}
      />
    );

    expect(screen.getByText(/blank to inherit the broader setting/)).toBeInTheDocument();
    expect(screen.getByLabelText("Cost limit (USD)")).toHaveAttribute("placeholder", "Inherit");
  });

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
