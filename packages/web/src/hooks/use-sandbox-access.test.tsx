// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

const mocks = vi.hoisted(() => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: mocks.browserApiFetch }));

import { useSandboxAccess } from "./use-sandbox-access";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

describe("useSandboxAccess", () => {
  beforeEach(() => vi.resetAllMocks());

  it("fetches credentials only through the client BFF with no-store", async () => {
    mocks.browserApiFetch.mockResolvedValue(
      Response.json({
        codeServer: { url: "https://code.example", password: "secret" },
        vnc: { url: "https://desktop.example", password: "desktop-secret" },
        ttyd: null,
        tunnelUrls: { "3000": "https://app.example" },
        sandboxDashboardUrl: "https://modal.example/sandbox/sb-123",
      })
    );
    const { result } = renderHook(() => useSandboxAccess("session/one", true), { wrapper });

    await waitFor(() =>
      expect(result.current.sandboxAccess).toEqual(
        expect.objectContaining({
          codeServerPassword: "secret",
          vncUrl: "https://desktop.example",
          vncPassword: "desktop-secret",
          tunnelUrls: { "3000": "https://app.example" },
          sandboxDashboardUrl: "https://modal.example/sandbox/sb-123",
        })
      )
    );
    expect(mocks.browserApiFetch).toHaveBeenCalledWith(
      "/api/sessions/session%2Fone/sandbox-access",
      { cache: "no-store" }
    );
  });

  it.each([204, 404])("authoritatively clears credentials on status %s", async (status) => {
    mocks.browserApiFetch.mockResolvedValue(new Response(null, { status }));
    const { result } = renderHook(() => useSandboxAccess("session-1", true), { wrapper });
    await waitFor(() => expect(result.current.sandboxAccess).toBeNull());
  });

  it("defaults protected access metadata to null for older control-plane responses", async () => {
    mocks.browserApiFetch.mockResolvedValue(
      Response.json({
        codeServer: null,
        vnc: null,
        ttyd: { url: "https://terminal.example", token: "terminal-token" },
      })
    );

    const { result } = renderHook(() => useSandboxAccess("session-1", true), { wrapper });

    await waitFor(() =>
      expect(result.current.sandboxAccess).toEqual({
        codeServerUrl: null,
        codeServerPassword: null,
        vncUrl: null,
        vncPassword: null,
        ttydUrl: "https://terminal.example",
        ttydToken: "terminal-token",
        tunnelUrls: null,
        sandboxDashboardUrl: null,
      })
    );
  });

  it("throws on malformed sandbox access responses instead of exposing partial credentials", async () => {
    mocks.browserApiFetch.mockResolvedValue(
      Response.json({
        codeServer: { url: "https://code.example", password: 123 },
        vnc: null,
        ttyd: null,
      })
    );

    const { result } = renderHook(() => useSandboxAccess("session-1", true), { wrapper });

    await waitFor(() => expect(result.current.sandboxAccess).toBeUndefined());
    await waitFor(() => expect(mocks.browserApiFetch).toHaveBeenCalledOnce());
  });

  it("clears cached credentials without revalidating", async () => {
    mocks.browserApiFetch.mockResolvedValue(
      Response.json({
        codeServer: { url: "https://code.example", password: "secret" },
        vnc: null,
        ttyd: null,
      })
    );
    const { result } = renderHook(() => useSandboxAccess("session-1", true), { wrapper });

    await waitFor(() => expect(result.current.sandboxAccess?.codeServerPassword).toBe("secret"));
    await act(async () => {
      await result.current.clear();
    });

    expect(result.current.sandboxAccess).toBeNull();
    expect(mocks.browserApiFetch).toHaveBeenCalledOnce();
  });

  it("refreshes by clearing stale credentials before revalidating", async () => {
    mocks.browserApiFetch
      .mockResolvedValueOnce(
        Response.json({
          codeServer: { url: "https://code.example", password: "old-secret" },
          vnc: null,
          ttyd: null,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          codeServer: { url: "https://code.example", password: "new-secret" },
          vnc: null,
          ttyd: null,
        })
      );
    const { result } = renderHook(() => useSandboxAccess("session-1", true), { wrapper });

    await waitFor(() =>
      expect(result.current.sandboxAccess?.codeServerPassword).toBe("old-secret")
    );
    let refresh: Promise<unknown>;
    await act(async () => {
      refresh = result.current.refresh();
      await Promise.resolve();
      expect(result.current.sandboxAccess).toBeNull();
      await refresh;
    });

    await waitFor(() =>
      expect(result.current.sandboxAccess?.codeServerPassword).toBe("new-secret")
    );
    expect(mocks.browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("does not fetch until the sandbox is ready", async () => {
    mocks.browserApiFetch.mockResolvedValue(
      Response.json({ codeServer: null, vnc: null, ttyd: null })
    );
    const { rerender } = renderHook(
      ({ isSandboxReady }) => useSandboxAccess("session-1", isSandboxReady),
      { wrapper, initialProps: { isSandboxReady: false } }
    );

    expect(mocks.browserApiFetch).not.toHaveBeenCalled();

    rerender({ isSandboxReady: true });
    await waitFor(() => expect(mocks.browserApiFetch).toHaveBeenCalledOnce());
  });
});
