import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionPullRequestStore } from "../../src/db/session-pull-request-store";
import type { SessionPullRequestRecord } from "../../src/db/session-pull-request-store";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO } from "./helpers";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createIndexedSession(sessionName: string) {
  const { stub } = await initNamedSession(sessionName);
  await new SessionIndexStore(env.DB).create({
    id: sessionName,
    title: null,
    repoOwner: "acme",
    repoName: "web-app",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return stub;
}

async function seedPrArtifact(stub: DurableObjectStub, sessionName: string) {
  const createdAt = Date.now() - 60_000;
  await queryDO(
    stub,
    "INSERT INTO artifacts (id, type, url, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    "artifact-pr-1",
    "pr",
    "https://github.com/acme/web-app/pull/7",
    JSON.stringify({
      number: 7,
      state: "open",
      lifecycleState: "open",
      isDraft: false,
      head: `open-inspect/${sessionName}`,
      base: "main",
      repoOwner: "acme",
      repoName: "web-app",
      repositoryExternalId: "12345",
    }),
    createdAt,
    createdAt
  );
}

function makeRecord(
  sessionName: string,
  overrides: Partial<SessionPullRequestRecord> = {}
): SessionPullRequestRecord {
  return {
    artifactId: "artifact-pr-1",
    sessionId: sessionName,
    repositoryExternalId: "12345",
    repoOwner: "acme",
    repoName: "web-app",
    prNumber: 7,
    url: "https://github.com/acme/web-app/pull/7",
    lifecycleState: "open",
    isDraft: false,
    headBranch: `open-inspect/${sessionName}`,
    baseBranch: "main",
    headSha: null,
    providerUpdatedAt: 1000,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function makePullRequestEvent(
  sessionName: string,
  overrides: Record<string, unknown> = {},
  factsOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    source: "github",
    eventType: "pull_request.closed",
    triggerKey: "pr:7:closed:abc123",
    concurrencyKey: "pr:7",
    contextBlock: "",
    meta: {},
    repoOwner: "acme",
    repoName: "web-app",
    branch: `open-inspect/${sessionName}`,
    targetBranch: "main",
    pullRequest: {
      number: 7,
      state: "closed",
      merged: true,
      draft: false,
      headSha: "abc123",
      isCrossRepository: false,
      url: "https://github.com/acme/web-app/pull/7",
      repositoryExternalId: "12345",
      providerUpdatedAt: 5000,
      ...factsOverrides,
    },
    ...overrides,
  };
}

async function postGitHubEvent(body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://test.local/internal/github-event", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
}

describe("PR lifecycle tracking on /internal/github-event", () => {
  beforeEach(cleanD1Tables);

  it("updates the correlated D1 record and the DO artifact mirror", async () => {
    const sessionName = `pr-lifecycle-hit-${Date.now()}`;
    const stub = await createIndexedSession(sessionName);
    await seedPrArtifact(stub, sessionName);
    const store = new SessionPullRequestStore(env.DB);
    await store.upsert(makeRecord(sessionName));

    const res = await postGitHubEvent(makePullRequestEvent(sessionName));
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const record = await store.getByArtifactId("artifact-pr-1");
      expect(record?.lifecycleState).toBe("merged");
      expect(record?.headSha).toBe("abc123");
      expect(record?.providerUpdatedAt).toBe(5000);
    });

    await vi.waitFor(async () => {
      const rows = await queryDO<{ metadata: string }>(
        stub,
        "SELECT metadata FROM artifacts WHERE id = ?",
        "artifact-pr-1"
      );
      const metadata = JSON.parse(rows[0].metadata) as Record<string, unknown>;
      expect(metadata.lifecycleState).toBe("merged");
      expect(metadata.state).toBe("merged");
    });
  });

  it("repairs a missing D1 record via the branch-derived fallback", async () => {
    const sessionName = `pr-lifecycle-miss-${Date.now()}`;
    const stub = await createIndexedSession(sessionName);
    await seedPrArtifact(stub, sessionName);
    const store = new SessionPullRequestStore(env.DB);

    const res = await postGitHubEvent(makePullRequestEvent(sessionName));
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const record = await store.getByArtifactId("artifact-pr-1");
      expect(record).not.toBeNull();
      expect(record?.sessionId).toBe(sessionName);
      expect(record?.lifecycleState).toBe("merged");
      expect(record?.repositoryExternalId).toBe("12345");
    });
  });

  it("does not regress state on an out-of-order webhook", async () => {
    const sessionName = `pr-lifecycle-stale-${Date.now()}`;
    const stub = await createIndexedSession(sessionName);
    await seedPrArtifact(stub, sessionName);
    const store = new SessionPullRequestStore(env.DB);
    await store.upsert(
      makeRecord(sessionName, { lifecycleState: "merged", providerUpdatedAt: 9000 })
    );

    const res = await postGitHubEvent(
      makePullRequestEvent(sessionName, {}, { state: "open", merged: false })
    );
    expect(res.status).toBe(200);

    // The event forwards + processes in the background; give it a beat, then
    // confirm nothing regressed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const record = await store.getByArtifactId("artifact-pr-1");
    expect(record?.lifecycleState).toBe("merged");
    expect(record?.providerUpdatedAt).toBe(9000);
  });

  it("still answers 200 and advances D1 when the DO snapshot push fails", async () => {
    const sessionName = `pr-lifecycle-push-fail-${Date.now()}`;
    await createIndexedSession(sessionName);
    // Authority record points at an artifact the DO does not hold — the
    // snapshot push 404s and must surface as a failure, never as success.
    const store = new SessionPullRequestStore(env.DB);
    await store.upsert(makeRecord(sessionName, { artifactId: "artifact-gone" }));

    const res = await postGitHubEvent(makePullRequestEvent(sessionName));
    expect(res.status).toBe(200);

    // The D1 authority advances before the failing mirror push; read-through
    // repairs the mirror later.
    await vi.waitFor(async () => {
      const record = await store.getByArtifactId("artifact-gone");
      expect(record?.lifecycleState).toBe("merged");
    });
  });

  it("drops events on non-Open-Inspect branches", async () => {
    const sessionName = `pr-lifecycle-drop-${Date.now()}`;
    const stub = await createIndexedSession(sessionName);
    await seedPrArtifact(stub, sessionName);
    const store = new SessionPullRequestStore(env.DB);

    const res = await postGitHubEvent(
      makePullRequestEvent(sessionName, { branch: "feature/manual-branch" })
    );
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await store.getByArtifactId("artifact-pr-1")).toBeNull();
  });

  it("keeps the automation forward contract for non-PR events", async () => {
    const res = await postGitHubEvent({
      source: "github",
      eventType: "issues.opened",
      triggerKey: "issue:1:opened",
      concurrencyKey: "issue:1",
      contextBlock: "",
      meta: {},
      repoOwner: "acme",
      repoName: "web-app",
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });
});

describe("POST /sessions/:id/pull-requests/refresh", () => {
  beforeEach(cleanD1Tables);

  it("returns 202 and never blocks on provider reads", async () => {
    const sessionName = `pr-refresh-${Date.now()}`;
    await createIndexedSession(sessionName);

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
    const res = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/pull-requests/refresh`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "refreshing" });
  });
});
