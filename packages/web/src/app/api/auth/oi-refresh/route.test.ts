import { beforeEach, describe, expect, it, vi } from "vitest";
import { encode, decode } from "next-auth/jwt";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("@/lib/control-plane-transport", () => ({
  controlPlaneServiceFetch: vi.fn(),
}));

import { cookies } from "next/headers";
import { controlPlaneServiceFetch } from "@/lib/control-plane-transport";
import { OI_ACCESS_TOKEN_RENEW_WINDOW_MS } from "@/lib/oi-session";
import { POST } from "./route";

const serviceFetch = vi.mocked(controlPlaneServiceFetch);

const SECRET = "test-nextauth-secret-for-oi-refresh";
const SECURE_COOKIE = "__Secure-next-auth.session-token";

const FRESH_PAIR = {
  accessToken: "oi_at_rotated",
  accessTokenExpiresAtEpochMs: Date.now() + 8 * 60 * 60 * 1000,
  refreshToken: "oi_rt_rotated",
  refreshTokenExpiresAtEpochMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
};

interface SetCall {
  name: string;
  value: string;
  options: { maxAge: number };
}

function fakeCookieStore(initial: Record<string, string>) {
  const sets: SetCall[] = [];
  const store = {
    sets,
    getAll: () => Object.entries(initial).map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: SetCall["options"]) => {
      sets.push({ name, value, options });
    },
  };
  vi.mocked(cookies).mockResolvedValue(store as never);
  return store;
}

async function encodeSession(oiFields: Record<string, unknown>): Promise<string> {
  return encode({
    token: { sub: "user-1", provider: "github", ...oiFields },
    secret: SECRET,
  });
}

beforeEach(() => {
  serviceFetch.mockReset();
  vi.mocked(cookies).mockReset();
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
  vi.stubEnv("NEXTAUTH_URL", "https://open-inspect.example");
});

describe("POST /api/auth/oi-refresh", () => {
  it("rotates a near-expiry pair and persists the re-encoded session cookie", async () => {
    serviceFetch.mockResolvedValue(new Response(JSON.stringify(FRESH_PAIR), { status: 200 }));
    const jwt = await encodeSession({
      oiAccessToken: "oi_at_near_expiry",
      oiAccessTokenExpiresAt: Date.now() + OI_ACCESS_TOKEN_RENEW_WINDOW_MS - 60_000,
      oiRefreshToken: "oi_rt_current",
    });
    const store = fakeCookieStore({ [SECURE_COOKIE]: jwt });

    const response = await POST();
    const body = (await response.json()) as { renewed: boolean };

    expect(response.status).toBe(200);
    expect(body.renewed).toBe(true);
    expect(serviceFetch).toHaveBeenCalledWith("/auth/tokens/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: "oi_rt_current" }),
    });

    // The rotated pair must round-trip out of the persisted cookie, and the
    // untouched claims must survive the re-encode.
    const written = store.sets.find((s) => s.name === SECURE_COOKIE && s.options.maxAge > 0);
    expect(written).toBeDefined();
    const decoded = await decode({ token: written!.value, secret: SECRET });
    expect(decoded).toMatchObject({
      sub: "user-1",
      provider: "github",
      oiAccessToken: "oi_at_rotated",
      oiRefreshToken: "oi_rt_rotated",
    });
  });

  it("does not write when the pair is still fresh", async () => {
    const jwt = await encodeSession({
      oiAccessToken: "oi_at_live",
      oiAccessTokenExpiresAt: Date.now() + OI_ACCESS_TOKEN_RENEW_WINDOW_MS + 60_000,
      oiRefreshToken: "oi_rt_live",
    });
    const store = fakeCookieStore({ [SECURE_COOKIE]: jwt });

    const response = await POST();
    const body = (await response.json()) as { renewed: boolean };

    expect(response.status).toBe(200);
    expect(body.renewed).toBe(false);
    expect(serviceFetch).not.toHaveBeenCalled();
    expect(store.sets).toHaveLength(0);
  });

  it("persists cleared fields when the refresh grant is dead", async () => {
    serviceFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "refresh_reuse_detected" }), { status: 401 })
    );
    const jwt = await encodeSession({
      oiAccessToken: "oi_at_stolen",
      oiAccessTokenExpiresAt: Date.now() + OI_ACCESS_TOKEN_RENEW_WINDOW_MS - 60_000,
      oiRefreshToken: "oi_rt_stolen",
    });
    const store = fakeCookieStore({ [SECURE_COOKIE]: jwt });

    const response = await POST();
    const body = (await response.json()) as { renewed: boolean };

    expect(body.renewed).toBe(true);
    const written = store.sets.find((s) => s.name === SECURE_COOKIE && s.options.maxAge > 0);
    const decoded = await decode({ token: written!.value, secret: SECRET });
    expect(decoded?.oiAccessToken).toBeUndefined();
    expect(decoded?.oiRefreshToken).toBeUndefined();
    expect(response.status).toBe(200);
  });

  it("401s when there is no decodable session", async () => {
    fakeCookieStore({});
    const response = await POST();
    expect(response.status).toBe(401);
  });
});
