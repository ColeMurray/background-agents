import { beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import { readOiAccessTokenFromCookiePairs } from "@/lib/oi-session";
import { sessionCookieName, writeSessionCookie } from "@/lib/session-cookie";

vi.mock("@/lib/control-plane-transport", () => ({
  controlPlaneServiceFetch: vi.fn(),
}));

const SECRET = "test-nextauth-secret-for-round-trip";
const SECURE_COOKIE = "__Secure-next-auth.session-token";

interface SetCall {
  name: string;
  value: string;
  options: { maxAge: number; secure: boolean; httpOnly: boolean };
}

function fakeStore(initial: Record<string, string> = {}) {
  const sets: SetCall[] = [];
  return {
    sets,
    getAll: () => Object.entries(initial).map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: SetCall["options"]) => {
      sets.push({ name, value, options });
    },
  };
}

/** Apply the writer's set calls the way a browser would, then read back. */
function toCookiePairs(initial: Record<string, string>, sets: SetCall[]): Record<string, string> {
  const pairs = { ...initial };
  for (const { name, value, options } of sets) {
    if (options.maxAge === 0) delete pairs[name];
    else pairs[name] = value;
  }
  return pairs;
}

async function encodeSessionJwt(extraClaims: Record<string, unknown> = {}): Promise<string> {
  return encode({
    token: {
      oiAccessToken: "oi_at_round_trip",
      oiAccessTokenExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
      oiRefreshToken: "oi_rt_round_trip",
      ...extraClaims,
    },
    secret: SECRET,
  });
}

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
  vi.stubEnv("NEXTAUTH_URL", "https://open-inspect.example");
});

describe("sessionCookieName", () => {
  it("uses the __Secure- prefix exactly when NEXTAUTH_URL is https", () => {
    expect(sessionCookieName()).toBe(SECURE_COOKIE);
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    expect(sessionCookieName()).toBe("next-auth.session-token");
  });
});

describe("writeSessionCookie", () => {
  it("writes a single secure cookie that next-auth's reader decodes", async () => {
    const jwt = await encodeSessionJwt();
    const store = fakeStore();

    writeSessionCookie(store, jwt);

    expect(store.sets).toHaveLength(1);
    expect(store.sets[0]).toMatchObject({
      name: SECURE_COOKIE,
      options: { httpOnly: true, secure: true },
    });
    await expect(readOiAccessTokenFromCookiePairs(toCookiePairs({}, store.sets))).resolves.toBe(
      "oi_at_round_trip"
    );
  });

  it("chunks oversized values the way next-auth reassembles them", async () => {
    const jwt = await encodeSessionJwt({ padding: "x".repeat(6000) });
    const store = fakeStore();

    writeSessionCookie(store, jwt);

    expect(store.sets.length).toBeGreaterThan(1);
    expect(store.sets.map((s) => s.name)).toEqual(
      store.sets.map((_, i) => `${SECURE_COOKIE}.${i}`)
    );
    for (const set of store.sets) {
      expect(set.value.length).toBeLessThanOrEqual(4096 - 163);
    }
    await expect(readOiAccessTokenFromCookiePairs(toCookiePairs({}, store.sets))).resolves.toBe(
      "oi_at_round_trip"
    );
  });

  it("expires stale chunks when a new value fits in one cookie", async () => {
    const jwt = await encodeSessionJwt();
    const stale = {
      [`${SECURE_COOKIE}.0`]: "stale-first-half",
      [`${SECURE_COOKIE}.1`]: "stale-second-half",
    };
    const store = fakeStore(stale);

    writeSessionCookie(store, jwt);

    const expired = store.sets.filter((s) => s.options.maxAge === 0).map((s) => s.name);
    expect(expired).toEqual([`${SECURE_COOKIE}.0`, `${SECURE_COOKIE}.1`]);
    await expect(readOiAccessTokenFromCookiePairs(toCookiePairs(stale, store.sets))).resolves.toBe(
      "oi_at_round_trip"
    );
  });

  it("expires the stale base cookie when the new value chunks", async () => {
    const jwt = await encodeSessionJwt({ padding: "x".repeat(6000) });
    const stale = { [SECURE_COOKIE]: "stale-unchunked" };
    const store = fakeStore(stale);

    writeSessionCookie(store, jwt);

    const expired = store.sets.filter((s) => s.options.maxAge === 0).map((s) => s.name);
    expect(expired).toEqual([SECURE_COOKIE]);
    await expect(readOiAccessTokenFromCookiePairs(toCookiePairs(stale, store.sets))).resolves.toBe(
      "oi_at_round_trip"
    );
  });
});
