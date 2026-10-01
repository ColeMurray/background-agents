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
import { resolveSessionCredentialScope } from "../../src/source-control/session-scope";
import { SessionIndexStore } from "../../src/db/session-index";
import { resolveImageBuildTokenScope } from "../../src/image-builds/credential-scope";
import {
  readCachedInstallationRepositories,
  REPOS_CACHE_KEY,
  reposCacheIdentity,
} from "../../src/repos/cache";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { cleanD1Tables } from "./cleanup";

let privateKey: string;
const cacheStore = createKvCacheStore(env.REPOS_CACHE);
const cacheBindings = { cacheStore, userAgent: "scoped-token-test" };
const catalogEnv = { REPOS_CACHE: cacheStore, GITHUB_APP_INSTALLATION_ID: "installation-1" };
const loadCatalog = () => readCachedInstallationRepositories(catalogEnv);

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

async function seedSession(
  id: string,
  ids: number[],
  ownerTeamId: string | null = null
): Promise<void> {
  const repositories = ids.map((repoId) => ({
    repoOwner: "acme",
    repoName: `repo-${repoId}`,
    repoId,
    baseBranch: "main",
  }));
  await new SessionIndexStore(env.DB).create({
    id,
    ownerTeamId,
    visibility: "workspace",
    title: null,
    repoOwner: repositories[0]?.repoOwner ?? null,
    repoName: repositories[0]?.repoName ?? null,
    repositories,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: repositories.length ? "main" : null,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
}

const sessionScope = (sessionId: string) =>
  resolveSessionCredentialScope(env.DB, sessionId, loadCatalog);

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

describe("session repository installation tokens over D1 and KV", () => {
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

  it.each([null, "team_a"])(
    "never shares tokens between different session repositories for owner %s",
    async (ownerTeamId) => {
      await seedTeam("team_a");
      await grant("team_a", 12);
      await grant("team_a", 2);
      await grant("team_a", 99);
      await grant("team_a", 77);
      await seedSession("session-a", [12, 2], ownerTeamId);
      await seedSession("session-b", [99], ownerTeamId);
      const mint = mockMint();
      const app = config(`different-sessions-${ownerTeamId ?? "workspace"}`);
      const scopeA = await sessionScope("session-a");
      const scopeB = await sessionScope("session-b");

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
    }
  );

  it("mints once for a newly added grant and never reuses a broader token after removal", async () => {
    await seedTeam("team_a");
    await grant("team_a", 12);
    await seedSession("session-a", [12, 99], "team_a");
    const mint = mockMint();
    const app = config("grant-changes");
    const original = await sessionScope("session-a");
    const tokenOriginal = await getCachedInstallationToken(app, cacheBindings, { scope: original });

    await grant("team_a", 99);
    const expanded = await sessionScope("session-a");
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
    const narrowed = await sessionScope("session-a");
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
    await grant("team_a", 77);
    await grant("team_b", 88);
    await seedSession("session-a", [12, 99], "team_a");
    await seedSession("session-b", [99, 12], "team_b");
    const mint = mockMint();
    const app = config("identical-sets");
    const token = await getCachedInstallationToken(app, cacheBindings, {
      scope: await sessionScope("session-a"),
    });
    await env.DB.prepare("UPDATE teams SET grants_version = grants_version + 1 WHERE id = ?")
      .bind("team_b")
      .run();
    expect(
      await getCachedInstallationToken(app, cacheBindings, {
        scope: await sessionScope("session-b"),
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
    await seedSession("session-empty-grants", [12], "team_empty");
    const mint = mockMint();
    const app = config("empty-team");
    await getCachedInstallationToken(app, cacheBindings, { scope: { kind: "all" } });
    mint.mockClear();
    await expect(sessionScope("session-empty-grants")).rejects.toThrow("no repositories");
    expect(mint).not.toHaveBeenCalled();
  });

  it("refuses a workspace session without repositories instead of serving the all-scope token", async () => {
    await seedSession("session-no-repo", []);
    const mint = mockMint();
    await getCachedInstallationToken(config("no-repositories"), cacheBindings, {
      scope: { kind: "all" },
    });
    mint.mockClear();
    await expect(sessionScope("session-no-repo")).rejects.toThrow("no repositories");
    expect(mint).not.toHaveBeenCalled();
  });

  it("installation grants retain only session members, never other installation repositories", async () => {
    await seedTeam("team_all");
    await env.DB.prepare(
      "INSERT INTO team_repository_grants (id, team_id, grant_kind, created_at) VALUES (?, ?, 'installation', 1)"
    )
      .bind("grant-all", "team_all")
      .run();
    await seedSession("session-installation-grant", [12], "team_all");
    const mint = mockMint();
    await getCachedInstallationToken(config("installation-grant-session"), cacheBindings, {
      scope: await sessionScope("session-installation-grant"),
    });
    expect(JSON.parse(String(mint.mock.calls[0][1]?.body))).toEqual({ repository_ids: [12] });
  });

  it.each(["NULL member", "scalar fallback"])(
    "resolves a legacy %s from the cached catalog and refuses an unresolved identity",
    async (kind) => {
      await seedSession("session-null-id", [12]);
      if (kind === "scalar fallback") {
        await env.DB.prepare("DELETE FROM session_repositories WHERE session_id = ?")
          .bind("session-null-id")
          .run();
      } else {
        await env.DB.prepare("UPDATE session_repositories SET repo_id = NULL WHERE session_id = ?")
          .bind("session-null-id")
          .run();
      }
      await cacheStore.put(
        REPOS_CACHE_KEY,
        JSON.stringify({
          scmIdentity: await reposCacheIdentity(catalogEnv),
          cachedAt: new Date().toISOString(),
          repos: [12, 99].map((id) => ({
            id,
            owner: "acme",
            name: `repo-${id}`,
            fullName: `acme/repo-${id}`,
            description: null,
            private: true,
            archived: false,
            defaultBranch: "main",
          })),
        })
      );
      const mint = mockMint();
      await getCachedInstallationToken(config(`legacy-session-${kind}`), cacheBindings, {
        scope: await sessionScope("session-null-id"),
      });
      expect(JSON.parse(String(mint.mock.calls[0][1]?.body))).toEqual({ repository_ids: [12] });
      await env.DB.prepare(
        kind === "scalar fallback"
          ? "UPDATE sessions SET repo_name = ? WHERE id = ?"
          : "UPDATE session_repositories SET repo_name = ? WHERE session_id = ?"
      )
        .bind("missing", "session-null-id")
        .run();
      mint.mockClear();
      await expect(sessionScope("session-null-id")).rejects.toThrow("repository id unavailable");
      expect(mint).not.toHaveBeenCalled();
    }
  );

  it("mints a repository image-build token for that repository alone with no team grants", async () => {
    const mint = mockMint();
    const scope = await resolveImageBuildTokenScope(
      env.DB,
      { kind: "repo", id: "acme/repo-12" },
      {
        kind: "repo",
        repoId: 12,
        repositories: [{ repoOwner: "acme", repoName: "repo-12", baseBranch: "main" }],
        repositoriesFingerprint: "test-fingerprint",
      },
      loadCatalog
    );
    await getCachedInstallationToken(config("repository-build"), cacheBindings, { scope });
    expect(JSON.parse(String(mint.mock.calls[0][1]?.body))).toEqual({ repository_ids: [12] });
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
