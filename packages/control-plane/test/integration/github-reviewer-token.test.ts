import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import {
  getInstallationTokenCacheKey,
  INSTALLATION_TOKEN_CACHE_MAX_AGE_MS,
} from "../../src/auth/github-app";
import { TeamStore } from "../../src/db/teams";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, routeRequest, seedSandboxAuth, serviceFetch } from "./helpers";

/** The reviewed repository: the helper's default session repository. */
const REVIEWED_REPO_ID = 12345;

/**
 * A token already in the installation-token cache for the reviewed repository,
 * so the route answers without an installation-token exchange. The integration
 * outbound service throws on any unexpected request, so a route that reached for
 * the wrong App's credential, or a wider scope, would fail loudly rather than
 * return the wrong token.
 */
async function cacheInstallationToken(
  appId: string,
  installationId: string,
  token: string
): Promise<void> {
  const now = Date.now();
  const key = await getInstallationTokenCacheKey(
    { appId, installationId, privateKey: "" },
    { kind: "repositories", repositoryIds: [REVIEWED_REPO_ID] }
  );
  await env.REPOS_CACHE.put(
    key,
    JSON.stringify({
      token,
      expiresAtEpochMs: now + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS,
      cachedAtEpochMs: now,
    })
  );
}

function withReviewerApp(appId: string, installationId: string): WorkerBindings {
  return {
    ...env,
    GITHUB_REVIEWER_APP_ID: appId,
    GITHUB_REVIEWER_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
    GITHUB_REVIEWER_APP_INSTALLATION_ID: installationId,
  };
}

/** Request the reviewer token for `repository`; null omits the query parameter. */
function fetchReviewToken(
  sessionName: string,
  token: string,
  bindings: WorkerBindings,
  repository: string | null = "acme/web-app"
) {
  const query = repository === null ? "" : `?${new URLSearchParams({ repository })}`;
  return routeRequest(
    new Request(`http://localhost/sessions/${sessionName}/review-token${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    bindings,
    createExecutionContext()
  );
}

/** Observe outbound requests so a refusal can prove it never reached the token exchange. */
function spyOnTokenExchange() {
  const actualFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(actualFetch);
  return () => spy.mock.calls.filter(([input]) => String(input).includes("/access_tokens"));
}

/**
 * A GitHub bot session whose own sandbox holds `sandbox-token`. The scalar repository mirrors the
 * primary member, as production writes it.
 */
async function githubBotSession(
  sessionName: string,
  repositories?: Array<{ repoOwner: string; repoName: string; repoId: number; baseBranch: string }>
) {
  const primary = repositories?.[0];
  const { stub } = await initNamedSession(sessionName, {
    spawnSource: "github-bot",
    repositories,
    ...(primary
      ? { repoOwner: primary.repoOwner, repoName: primary.repoName, repoId: primary.repoId }
      : {}),
  });
  await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });
}

describe("reviewer app token broker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("mints the reviewer App's token for the named repository alone, not the primary", async () => {
    const suffix = `${Date.now()}`;
    const sessionName = `review-token-${suffix}`;
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const exported = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
    const encoded = btoa(String.fromCharCode(...new Uint8Array(exported)));
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
    const actualFetch = globalThis.fetch;
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === `https://api.github.com/app/installations/ri-${suffix}/access_tokens`) {
        const jwt = new Headers(init?.headers).get("Authorization")!.split(" ")[1];
        const claims = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        expect(claims.iss).toBe(`reviewer-${suffix}`);
        expect(init?.method).toBe("POST");
        // The session's primary is a context repository the reviewer App need not cover.
        expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [REVIEWED_REPO_ID] });
        return Response.json({
          token: "reviewer-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return actualFetch(input, init);
    });
    // The main App's credential is configured too, and would mint a different
    // token: the review POST must be authenticated as the reviewer App.
    await cacheInstallationToken(`main-${suffix}`, `mi-${suffix}`, "main-installation-token");

    // An environment launch orders members by the environment, so the reviewed repository
    // need not be the primary.
    await githubBotSession(sessionName, [
      { repoOwner: "acme", repoName: "shared-config", repoId: 67890, baseBranch: "main" },
      { repoOwner: "acme", repoName: "web-app", repoId: REVIEWED_REPO_ID, baseBranch: "main" },
    ]);

    const response = await fetchReviewToken(
      sessionName,
      "sandbox-token",
      {
        ...withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`),
        GITHUB_REVIEWER_APP_PRIVATE_KEY: privateKey,
        GITHUB_APP_ID: `main-${suffix}`,
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
        GITHUB_APP_INSTALLATION_ID: `mi-${suffix}`,
      },
      "ACME/Web-App"
    );

    expect(
      exchange.mock.calls.some(([input]) =>
        String(input).includes(`/installations/ri-${suffix}/access_tokens`)
      )
    ).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ token: "reviewer-installation-token" });
  });

  it("rejects a request that does not name a repository", async () => {
    const suffix = `unnamed-${Date.now()}`;
    await githubBotSession(`review-token-${suffix}`);

    for (const repository of [null, "", "web-app", "acme/", "/web-app"]) {
      const response = await fetchReviewToken(
        `review-token-${suffix}`,
        "sandbox-token",
        withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`),
        repository
      );
      expect(response.status, String(repository)).toBe(400);
    }
  });

  it("refuses a repository that is not a member of the session", async () => {
    const suffix = `non-member-${Date.now()}`;
    // Cached for the member repository, so only the membership check stands between the
    // request and a token.
    await cacheInstallationToken(
      `reviewer-${suffix}`,
      `ri-${suffix}`,
      "reviewer-installation-token"
    );
    await githubBotSession(`review-token-${suffix}`);
    const exchanges = spyOnTokenExchange();

    const response = await fetchReviewToken(
      `review-token-${suffix}`,
      "sandbox-token",
      withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`),
      "acme/other-repo"
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.text()).not.toContain("reviewer-installation-token");
    expect(exchanges()).toEqual([]);
  });

  it("refuses a GitHub bot session that has no repository", async () => {
    const suffix = `repoless-${Date.now()}`;
    const sessionName = `review-token-${suffix}`;
    const { stub } = await initNamedSession(sessionName, {
      spawnSource: "github-bot",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });
    const exchanges = spyOnTokenExchange();

    const response = await fetchReviewToken(
      sessionName,
      "sandbox-token",
      withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`)
    );

    expect(response.status).toBe(403);
    expect(exchanges()).toEqual([]);
  });

  it("refuses a repository outside the owner team's grants", async () => {
    const suffix = `ungranted-${Date.now()}`;
    const sessionName = `review-token-${suffix}`;
    // Cached for the requested repository, so only the grant check stands between the
    // request and a token.
    await cacheInstallationToken(
      `reviewer-${suffix}`,
      `ri-${suffix}`,
      "reviewer-installation-token"
    );
    await githubBotSession(sessionName);
    const team = await new TeamStore(env.DB).create({
      slug: `review-${crypto.randomUUID()}`,
      name: "Review team",
      joinPolicy: "invite_only",
    });
    await new TeamRepositoryGrantStore(env.DB).add(team.id, {
      kind: "repository",
      repoExternalId: 67890,
      owner: "acme",
      name: "shared-config",
    });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = ?")
      .bind(team.id, sessionName)
      .run();
    const exchanges = spyOnTokenExchange();

    const response = await fetchReviewToken(
      sessionName,
      "sandbox-token",
      withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`)
    );

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("reviewer-installation-token");
    expect(exchanges()).toEqual([]);
  });

  it("answers 404 when the deployment runs no reviewer App", async () => {
    const sessionName = `review-token-unconfigured-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchReviewToken(sessionName, "sandbox-token", env);

    expect(response.status).toBe(404);
  });

  it("refuses another session's sandbox token", async () => {
    const suffix = `cross-${Date.now()}`;
    const bindings = withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`);
    await cacheInstallationToken(
      `reviewer-${suffix}`,
      `ri-${suffix}`,
      "reviewer-installation-token"
    );

    const reviewed = `review-token-${suffix}`;
    const other = `other-session-${suffix}`;
    const { stub } = await initNamedSession(reviewed, { spawnSource: "github-bot" });
    await seedSandboxAuth(stub, { authToken: "reviewed-token", sandboxId: "sandbox-1" });
    const { stub: otherStub } = await initNamedSession(other, { spawnSource: "github-bot" });
    await seedSandboxAuth(otherStub, { authToken: "other-token", sandboxId: "sandbox-2" });

    const response = await fetchReviewToken(reviewed, "other-token", bindings);

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("reviewer-installation-token");
  });

  it("mints for a session the GitHub bot created through the session API", async () => {
    const suffix = `created-${Date.now()}`;
    await cacheInstallationToken(
      `reviewer-${suffix}`,
      `ri-${suffix}`,
      "reviewer-installation-token"
    );
    vi.spyOn(GitHubSourceControlProvider.prototype, "checkRepositoryAccess").mockResolvedValue({
      repoId: REVIEWED_REPO_ID,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    });
    const body = JSON.stringify({
      title: "GitHub: Review PR #1",
      model: "anthropic/claude-haiku-4-5",
      repoOwner: "acme",
      repoName: "web-app",
    });
    const created = await serviceFetch("https://test.local/sessions", {
      service: "github-bot",
      method: "POST",
      actor: "github:1001",
      body,
    });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json<{ sessionId: string }>();
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchReviewToken(
      sessionId,
      "sandbox-token",
      withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "reviewer-installation-token" });
  });

  it.each(["user", "agent", "automation", "slack-bot", "linear-bot"] as const)(
    "refuses the own sandbox of a session spawned by %s",
    async (spawnSource) => {
      const suffix = `${spawnSource}-${Date.now()}`;
      const bindings = withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`);
      await cacheInstallationToken(
        `reviewer-${suffix}`,
        `ri-${suffix}`,
        "reviewer-installation-token"
      );
      const sessionName = `non-review-${suffix}`;
      const { stub } = await initNamedSession(sessionName, { spawnSource });
      await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

      const response = await fetchReviewToken(sessionName, "sandbox-token", bindings);

      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(await response.text()).not.toContain("reviewer-installation-token");
    }
  );
});
