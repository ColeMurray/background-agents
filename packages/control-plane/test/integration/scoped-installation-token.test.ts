import { env } from "cloudflare:test";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedInstallationToken,
  getCachedInstallationTokenWithExpiry,
  getInstallationTokenCacheKey,
  INSTALLATION_TOKEN_CACHE_MAX_AGE_MS,
  INSTALLATION_TOKEN_MIN_REMAINING_MS,
  invalidateInstallationTokenCache,
  type GitHubAppConfig,
  type TokenScope,
} from "../../src/auth/github-app";
import { resolveTeamTokenScope } from "../../src/source-control/team-scope";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { cleanD1Tables } from "./cleanup";

let privateKey: string;
const cacheStore = createKvCacheStore(env.REPOS_CACHE);
const cacheBindings = { cacheStore, userAgent: "scoped-token-test" };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  if (!("privateKey" in pair)) throw new Error("Expected an RSA key pair");
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("Expected a PKCS#8 byte buffer");
  const bytes = new Uint8Array(exported);
  privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`;
});

beforeEach(cleanD1Tables);
afterEach(() => vi.restoreAllMocks());

function config(testName: string): GitHubAppConfig {
  return { appId: `scope-${testName}`, installationId: "installation-1", privateKey };
}

async function seedTeam(id: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
  )
    .bind(id, id, id)
    .run();
}

async function grant(teamId: string, repositoryId: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO team_repository_grants
     (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
     VALUES (?, ?, 'repository', ?, 'acme', ?, 1)`
  )
    .bind(`${teamId}-${repositoryId}`, teamId, repositoryId, `repo-${repositoryId}`)
    .run();
}

function mockMint() {
  let count = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (typeof input !== "string" || !input.endsWith("/access_tokens")) {
      throw new Error("Unexpected outbound request in scoped-token test");
    }
    expect(init?.method).toBe("POST");
    return Response.json({
      token: `scoped-token-${++count}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  });
}

describe("scoped installation tokens over D1 grants and KV", () => {
  it("reads a scoped KV entry on a cold memory cache without signing or minting", async () => {
    const app = { ...config("scoped-kv-hit"), privateKey: "invalid-key-must-not-be-used" };
    const scope: TokenScope = { kind: "repositories", repositoryIds: [12, 99] };
    const expiresAtEpochMs = Date.now() + 60 * 60 * 1000;
    await cacheStore.put(
      await getInstallationTokenCacheKey(app, scope),
      JSON.stringify({
        token: "persisted-scoped-token",
        expiresAtEpochMs,
        cachedAtEpochMs: Date.now(),
      })
    );
    const mint = mockMint();
    expect(await getCachedInstallationTokenWithExpiry(app, cacheBindings, { scope })).toEqual({
      token: "persisted-scoped-token",
      expiresAtEpochMs,
    });
    expect(mint).not.toHaveBeenCalled();
  });

  it.each([
    { name: "cache-age", ageMs: INSTALLATION_TOKEN_CACHE_MAX_AGE_MS, remainingMs: 60 * 60 * 1000 },
    { name: "near-expiry", ageMs: 0, remainingMs: INSTALLATION_TOKEN_MIN_REMAINING_MS },
  ])("refreshes a scoped KV entry at the $name limit", async ({ name, ageMs, remainingMs }) => {
    const app = config(name);
    const scope: TokenScope = { kind: "repositories", repositoryIds: [12] };
    await cacheStore.put(
      await getInstallationTokenCacheKey(app, scope),
      JSON.stringify({
        token: "unusable-token",
        expiresAtEpochMs: Date.now() + remainingMs,
        cachedAtEpochMs: Date.now() - ageMs,
      })
    );
    const mint = mockMint();
    expect(await getCachedInstallationToken(app, cacheBindings, { scope })).not.toBe(
      "unusable-token"
    );
    expect(mint).toHaveBeenCalledOnce();
    expect(JSON.parse(String(mint.mock.calls[0][1]?.body))).toEqual({ repository_ids: [12] });
  });

  it("never shares tokens or cache entries between different repository sets", async () => {
    await seedTeam("team_a");
    await seedTeam("team_b");
    await grant("team_a", 12);
    await grant("team_a", 2);
    await grant("team_b", 99);
    const mint = mockMint();
    const app = config("different-teams");
    const scopeA = await resolveTeamTokenScope(env.DB, "team_a");
    const scopeB = await resolveTeamTokenScope(env.DB, "team_b");

    const tokenA = await getCachedInstallationToken(app, cacheBindings, { scope: scopeA });
    const tokenB = await getCachedInstallationToken(app, cacheBindings, { scope: scopeB });
    expect(tokenB).not.toBe(tokenA);
    expect(mint.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { repository_ids: [2, 12] },
      { repository_ids: [99] },
    ]);
    const keyA = await getInstallationTokenCacheKey(app, scopeA);
    const keyB = await getInstallationTokenCacheKey(app, scopeB);
    expect(await cacheStore.get(keyA, "json")).toMatchObject({ token: tokenA });
    expect(await cacheStore.get(keyB, "json")).toMatchObject({ token: tokenB });
    expect(await getCachedInstallationToken(app, cacheBindings, { scope: scopeA })).toBe(tokenA);
    expect(await getCachedInstallationToken(app, cacheBindings, { scope: scopeB })).toBe(tokenB);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("mints once for a newly added grant and never reuses a broader token after removal", async () => {
    await seedTeam("team_a");
    await grant("team_a", 12);
    const mint = mockMint();
    const app = config("grant-changes");
    const original = await resolveTeamTokenScope(env.DB, "team_a");
    const tokenOriginal = await getCachedInstallationToken(app, cacheBindings, { scope: original });

    await grant("team_a", 99);
    const expanded = await resolveTeamTokenScope(env.DB, "team_a");
    const tokenExpanded = await getCachedInstallationToken(app, cacheBindings, { scope: expanded });
    expect(tokenExpanded).not.toBe(tokenOriginal);
    expect(await getInstallationTokenCacheKey(app, expanded)).not.toBe(
      await getInstallationTokenCacheKey(app, original)
    );
    expect(mint).toHaveBeenCalledTimes(2);

    await env.DB.prepare(
      "DELETE FROM team_repository_grants WHERE team_id = ? AND repo_external_id = ?"
    )
      .bind("team_a", 12)
      .run();
    const narrowed = await resolveTeamTokenScope(env.DB, "team_a");
    const tokenNarrowed = await getCachedInstallationToken(app, cacheBindings, { scope: narrowed });
    expect(tokenNarrowed).not.toBe(tokenExpanded);
    expect(mint).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(mint.mock.calls[2][1]?.body))).toEqual({ repository_ids: [99] });
  });

  it("shares a cached token for identical sets regardless of team, order, duplicates or version", async () => {
    await seedTeam("team_a");
    await seedTeam("team_b");
    await grant("team_a", 12);
    await grant("team_a", 99);
    await grant("team_b", 99);
    await grant("team_b", 12);
    const mint = mockMint();
    const app = config("identical-sets");
    const token = await getCachedInstallationToken(app, cacheBindings, {
      scope: await resolveTeamTokenScope(env.DB, "team_a"),
    });
    await env.DB.prepare("UPDATE teams SET grants_version = grants_version + 1 WHERE id = ?")
      .bind("team_b")
      .run();
    expect(
      await getCachedInstallationToken(app, cacheBindings, {
        scope: await resolveTeamTokenScope(env.DB, "team_b"),
      })
    ).toBe(token);
    expect(
      await getCachedInstallationTokenWithExpiry(app, cacheBindings, {
        scope: { kind: "repositories", repositoryIds: [99, 12, 99] },
      })
    ).toMatchObject({ token });
    expect(mint).toHaveBeenCalledOnce();
  });

  it("returns no token for a team with no grants even when an all-scope token is cached", async () => {
    await seedTeam("team_empty");
    const mint = mockMint();
    const app = config("empty-team");
    await getCachedInstallationToken(app, cacheBindings, { scope: { kind: "all" } });
    mint.mockClear();
    const scope = await resolveTeamTokenScope(env.DB, "team_empty");
    await expect(getCachedInstallationToken(app, cacheBindings, { scope })).rejects.toThrow(
      "no repository grants"
    );
    expect(mint).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent mints only for the same canonical scope", async () => {
    const mint = mockMint();
    const app = config("in-flight");
    const [first, duplicate, different] = await Promise.all([
      getCachedInstallationToken(app, cacheBindings, {
        scope: { kind: "repositories", repositoryIds: [12, 99] },
      }),
      getCachedInstallationToken(app, cacheBindings, {
        scope: { kind: "repositories", repositoryIds: [99, 12, 12] },
      }),
      getCachedInstallationToken(app, cacheBindings, {
        scope: { kind: "repositories", repositoryIds: [2] },
      }),
    ]);
    expect(first).toBe(duplicate);
    expect(different).not.toBe(first);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the requested scope in memory and KV", async () => {
    const mint = mockMint();
    const app = config("invalidation");
    const scopeA: TokenScope = { kind: "repositories", repositoryIds: [12] };
    const scopeB: TokenScope = { kind: "repositories", repositoryIds: [99] };
    const tokenA = await getCachedInstallationToken(app, cacheBindings, { scope: scopeA });
    const tokenB = await getCachedInstallationToken(app, cacheBindings, { scope: scopeB });
    const keyA = await getInstallationTokenCacheKey(app, scopeA);
    await invalidateInstallationTokenCache(cacheBindings, keyA);
    expect(await cacheStore.get(keyA)).toBeNull();
    expect(await getCachedInstallationToken(app, cacheBindings, { scope: scopeA })).not.toBe(
      tokenA
    );
    expect(await getCachedInstallationToken(app, cacheBindings, { scope: scopeB })).toBe(tokenB);
    expect(mint).toHaveBeenCalledTimes(3);
  });

  it("recovers a provider 401 through the real scoped caches without evicting another scope", async () => {
    const app = config("provider-401");
    const scopeA: TokenScope = { kind: "repositories", repositoryIds: [12] };
    const scopeB: TokenScope = { kind: "repositories", repositoryIds: [99] };
    const keyA = await getInstallationTokenCacheKey(app, scopeA);
    const keyB = await getInstallationTokenCacheKey(app, scopeB);
    for (const [key, token] of [
      [keyA, "rejected-token"],
      [keyB, "unaffected-token"],
    ]) {
      await cacheStore.put(
        key,
        JSON.stringify({
          token,
          expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
          cachedAtEpochMs: Date.now(),
        })
      );
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (typeof input !== "string") throw new Error("Unexpected request input");
      if (input.endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [12] });
        return Response.json({
          token: "replacement-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }
      expect(input).toBe("https://api.github.com/repos/acme/repo-12/git/ref/heads/main");
      if (new Headers(init?.headers).get("Authorization") === "Bearer rejected-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer replacement-token");
      return Response.json({ object: { sha: "branch-sha" } });
    });
    const provider = new GitHubSourceControlProvider({ appConfig: app, cacheStore });
    expect(
      await provider.getBranchHead({ owner: "acme", name: "repo-12", branch: "main" }, scopeA)
    ).toBe("branch-sha");
    expect(await getCachedInstallationToken(app, cacheBindings, { scope: scopeA })).toBe(
      "replacement-token"
    );
    expect(await getCachedInstallationToken(app, cacheBindings, { scope: scopeB })).toBe(
      "unaffected-token"
    );
    expect(await cacheStore.get(keyA, "json")).toMatchObject({ token: "replacement-token" });
    expect(await cacheStore.get(keyB, "json")).toMatchObject({ token: "unaffected-token" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ignores pre-scoping v1 entries and mints workspace access without a repository body", async () => {
    const app = config("v1-cache");
    await cacheStore.put(
      `github:installation-token:v1:${app.appId}:${app.installationId}`,
      JSON.stringify({
        token: "legacy-token",
        expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
        cachedAtEpochMs: Date.now(),
      })
    );
    const mint = mockMint();
    expect(
      await getCachedInstallationToken(app, cacheBindings, { scope: { kind: "all" } })
    ).not.toBe("legacy-token");
    expect(mint).toHaveBeenCalledOnce();
    expect(mint.mock.calls[0][1]?.body).toBeUndefined();
  });
});
