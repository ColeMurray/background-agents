// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  status: "authenticated",
  signOut: vi.fn(),
  cookies: vi.fn(),
  controlPlaneTokenFetch: vi.fn(),
  getToken: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: null, status: mocks.status }),
  signOut: mocks.signOut,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/lib/control-plane-transport", () => ({
  controlPlaneTokenFetch: mocks.controlPlaneTokenFetch,
}));

vi.mock("next-auth/jwt", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getToken: mocks.getToken };
});

import { POST } from "@/app/api/auth/oi-refresh/route";
import { WebSessionGate } from "./web-session-gate";

const SECRET = "test-nextauth-secret-for-web-session-gate";

beforeEach(() => {
  mocks.status = "authenticated";
  mocks.signOut.mockReset();
  mocks.cookies.mockReset();
  mocks.controlPlaneTokenFetch.mockReset();
  mocks.getToken.mockReset();
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
  vi.stubEnv("NEXTAUTH_URL", "https://open-inspect.example");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pre-exchange web session composition", () => {
  it("keeps application children hidden and signs out when the refresh route returns 401", async () => {
    const cookieWrites: unknown[] = [];
    mocks.getToken.mockResolvedValue({ sub: "user-1", provider: "github" });
    mocks.cookies.mockResolvedValue({
      getAll: () => [],
      set: (...args: unknown[]) => cookieWrites.push(args),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => POST())
    );

    render(
      <WebSessionGate>
        <div>Protected application</div>
      </WebSessionGate>
    );

    expect(screen.queryByText("Protected application")).toBeNull();
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
    expect(mocks.controlPlaneTokenFetch).not.toHaveBeenCalled();
    expect(cookieWrites).toHaveLength(0);
  });
});
