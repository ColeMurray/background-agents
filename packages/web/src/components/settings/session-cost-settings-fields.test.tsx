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
        onMaxSessionCostUsdChange={() => undefined}
      />
    );

    expect(screen.getByText(/blank to inherit the broader setting/)).toBeInTheDocument();
    expect(screen.getByLabelText("Cost limit (USD)")).toHaveAttribute("placeholder", "Inherit");
  });

  it("clears a scoped limit back to inheritance", () => {
    const { result } = renderHook(() =>
      useSessionCostSettings({ maxSessionCostUsd: 75 }, { maxSessionCostUsd: 80 }, false)
    );

    act(() => result.current.setMaxCost(""));
    const payload: SandboxSettings = {};
    result.current.apply(payload);

    expect(result.current.validate()).toBeNull();
    expect(payload).not.toHaveProperty("maxSessionCostUsd");
  });

  it("ignores limit whitespace when detecting changes", () => {
    const { result } = renderHook(() =>
      useSessionCostSettings({ maxSessionCostUsd: 75 }, undefined, false)
    );

    act(() => result.current.setMaxCost("75 "));

    expect(result.current.hasChanges).toBe(false);
  });
});
