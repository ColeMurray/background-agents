/**
 * Multi-repo session storage: DO member rows, D1 index hydration, and
 * route-level rejection of malformed repository lists.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, serviceFetch } from "./helpers";

type MemberRow = {
  position: number;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
};

describe("DO session_repositories rows", () => {
  it("persists the repositories list in position order on init", async () => {
    const { stub } = await initSession({
      repoOwner: "acme",
      repoName: "frontend",
      repoId: 1,
      defaultBranch: "main",
      repositories: [
        { repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
        { repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "develop" },
      ],
    });

    const rows = await queryDO<MemberRow>(
      stub,
      "SELECT position, repo_owner, repo_name, repo_id, base_branch FROM session_repositories ORDER BY position"
    );
    expect(rows).toEqual([
      { position: 0, repo_owner: "acme", repo_name: "frontend", repo_id: 1, base_branch: "main" },
      { position: 1, repo_owner: "acme", repo_name: "backend", repo_id: 2, base_branch: "develop" },
    ]);
  });

  it("synthesizes a one-entry member set for scalar inits", async () => {
    const { stub } = await initSession({
      repoOwner: "acme",
      repoName: "web-app",
      repoId: 12345,
      defaultBranch: "main",
    });

    const rows = await queryDO<MemberRow>(
      stub,
      "SELECT position, repo_owner, repo_name, repo_id, base_branch FROM session_repositories ORDER BY position"
    );
    expect(rows).toEqual([
      {
        position: 0,
        repo_owner: "acme",
        repo_name: "web-app",
        repo_id: 12345,
        base_branch: "main",
      },
    ]);
  });

  it("rejects a list whose primary does not match the scalar mirror", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    const res = await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: "mirror-mismatch",
        repoOwner: "acme",
        repoName: "frontend",
        repoId: 1,
        defaultBranch: "main",
        repositories: [{ repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "main" }],
        userId: "user-1",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "repositories[0] must match the scalar repository mirror",
    });
  });
});

describe("D1 session index repositories", () => {
  beforeEach(cleanD1Tables);

  function makeEntry(id: string, repositories?: SessionIndexRepositoryInput[]) {
    const now = Date.now();
    return {
      id,
      title: null,
      repoOwner: repositories?.[0]?.repoOwner ?? "acme",
      repoName: repositories?.[0]?.repoName ?? "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: repositories?.[0]?.baseBranch ?? "main",
      status: "created" as const,
      createdAt: now,
      updatedAt: now,
      repositories,
    };
  }

  type SessionIndexRepositoryInput = {
    repoOwner: string;
    repoName: string;
    repoId: number | null;
    baseBranch: string;
  };

  it("persists member rows on create and hydrates them on list", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(
      makeEntry("multi-1", [
        { repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
        { repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "develop" },
      ])
    );

    const { sessions } = await store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].repositories).toEqual([
      { repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
      { repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "develop" },
    ]);
  });

  it("leaves repositories absent for sessions without member rows", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(makeEntry("scalar-1"));

    const { sessions } = await store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].repositories).toBeUndefined();
  });

  it("list repo filters match secondary members", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(
      makeEntry("multi-filter", [
        { repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
        { repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "main" },
      ])
    );
    await store.create(
      makeEntry("other-filter", [
        { repoOwner: "acme", repoName: "unrelated", repoId: 3, baseBranch: "main" },
      ])
    );

    const bySecondary = await store.list({ repoOwner: "acme", repoName: "backend" });
    expect(bySecondary.sessions.map((s) => s.id)).toEqual(["multi-filter"]);

    const byPrimary = await store.list({ repoOwner: "acme", repoName: "frontend" });
    expect(byPrimary.sessions.map((s) => s.id)).toEqual(["multi-filter"]);
  });

  it("list repo filters fall back to scalars for pre-feature sessions", async () => {
    const store = new SessionIndexStore(env.DB);
    // No repositories list — simulates a session created before the
    // membership table existed (scalar columns only).
    await store.create(makeEntry("legacy-filter"));

    const result = await store.list({ repoOwner: "acme", repoName: "web-app" });
    expect(result.sessions.map((s) => s.id)).toEqual(["legacy-filter"]);
  });

  it("deletes member rows together with the session", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(
      makeEntry("multi-2", [
        { repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
      ])
    );

    expect(await store.delete("multi-2")).toBe(true);

    const orphans = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM session_repositories WHERE session_id = ?"
    )
      .bind("multi-2")
      .first<{ count: number }>();
    expect(orphans?.count).toBe(0);
  });
});

describe("POST /sessions repository list validation", () => {
  beforeEach(cleanD1Tables);

  // session-create requires a participant identity: sign as a bot with an
  // asserted actor (the userless web service credential is rejected, 403).
  const actorAuth = { service: "slack-bot", actor: "slack:U0123" } as const;

  it("rejects repositories combined with scalar repo fields", async () => {
    const res = await serviceFetch("https://test.local/sessions", {
      method: "POST",
      body: JSON.stringify({
        repoOwner: "acme",
        repoName: "web-app",
        repositories: [{ repoOwner: "acme", repoName: "frontend" }],
      }),
      ...actorAuth,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid session request body" });
  });

  it("rejects an empty repositories list", async () => {
    const res = await serviceFetch("https://test.local/sessions", {
      method: "POST",
      body: JSON.stringify({ repositories: [] }),
      ...actorAuth,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid session request body" });
  });

  it("names every unresolvable repository in the failure", async () => {
    // The test env has no GitHub App configured, so every lookup throws —
    // the resolver must aggregate rather than fail on the first entry.
    const res = await serviceFetch("https://test.local/sessions", {
      method: "POST",
      body: JSON.stringify({
        repositories: [
          { repoOwner: "acme", repoName: "frontend" },
          { repoOwner: "acme", repoName: "backend" },
        ],
      }),
      ...actorAuth,
    });

    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("acme/frontend");
    expect(body.error).toContain("acme/backend");
  });
});
