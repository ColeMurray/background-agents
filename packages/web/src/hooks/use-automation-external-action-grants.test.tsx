// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  automationExternalActionGrantsKey,
  useAutomationExternalActionGrants,
} from "./use-automation-external-action-grants";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const grant = {
  id: "grant-1",
  automationId: "auto-1",
  executorUserId: "user-1",
  provider: "github",
  action: "comment",
  createdBy: "user-1",
  createdAt: 1_700_000_000_000,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

describe("useAutomationExternalActionGrants", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses the automation-scoped grants key", () => {
    expect(automationExternalActionGrantsKey("auto-1")).toBe(
      "/api/automations/auto-1/external-action-grants"
    );
  });

  it("loads the grants the control plane owns", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ grants: [grant] }));
    const { result } = renderHook(() => useAutomationExternalActionGrants("auto-1", true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.grants).toHaveLength(1));
    expect(result.current.grants[0]).toMatchObject({ id: "grant-1", provider: "github" });
  });

  it("does not request anything while the capability is disabled", async () => {
    const { result } = renderHook(() => useAutomationExternalActionGrants("auto-1", false), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("creates a grant through the control plane", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ grants: [] }))
      .mockResolvedValueOnce(Response.json({ grant }))
      .mockResolvedValueOnce(Response.json({ grants: [grant] }));
    const { result } = renderHook(() => useAutomationExternalActionGrants("auto-1", true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.grants).toHaveLength(0));
    await act(async () => {
      await result.current.create("github", "comment");
    });

    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/automations/auto-1/external-action-grants",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("surfaces a refused grant instead of pretending it succeeded", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ grants: [] }))
      .mockResolvedValueOnce(
        Response.json({ error: "Forbidden", code: "permission_required" }, { status: 403 })
      );
    const { result } = renderHook(() => useAutomationExternalActionGrants("auto-1", true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.grants).toHaveLength(0));
    await act(async () => {
      await expect(result.current.create("github", "comment")).rejects.toThrow();
    });
  });
});
