// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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
      })
    );
    const { result } = renderHook(() => useSandboxAccess("session/one"), { wrapper });

    await waitFor(() =>
      expect(result.current.sandboxAccess).toEqual(
        expect.objectContaining({
          codeServerPassword: "secret",
          vncUrl: "https://desktop.example",
          vncPassword: "desktop-secret",
        })
      )
    );
    expect(mocks.browserApiFetch).toHaveBeenCalledWith(
      "/api/sessions/session%2Fone/sandbox-access",
      { cache: "no-store" }
    );
  });

  it.each([404, 409])("authoritatively clears credentials on status %s", async (status) => {
    mocks.browserApiFetch.mockResolvedValue(new Response(null, { status }));
    const { result } = renderHook(() => useSandboxAccess("session-1"), { wrapper });
    await waitFor(() => expect(result.current.sandboxAccess).toBeNull());
  });
});
