import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import {
  SESSION_DIFF_FAILURE_BODY_MAX_BYTES,
  SESSION_DIFF_UPLOAD_BODY_MAX_BYTES,
} from "../../src/routes/session-diffs";
import {
  collectMessages,
  initNamedSession,
  openSandboxWs,
  queryDO,
  seedSandboxAuth,
} from "./helpers";

async function internalAuthHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}` };
}

async function reportReady(
  stub: DurableObjectStub,
  repositories: Array<{
    position: number;
    repoOwner: string;
    repoName: string;
    baseSha: string;
  }>
): Promise<void> {
  const response = await stub.fetch("http://internal/internal/sandbox-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "ready",
      sandboxId: "sandbox-diff",
      timestamp: 100,
      repositories,
    }),
  });
  expect(response.status).toBe(200);
}

function bundle(baseSha: string, patch = "diff --git a/src/app.ts b/src/app.ts\n") {
  return {
    version: 1,
    triggerMessageId: "message-1",
    capturedAt: 100,
    repositories: [
      {
        status: "ready",
        position: 0,
        repoOwner: "acme",
        repoName: "web-app",
        baseSha,
        headSha: "b".repeat(40),
        truncated: false,
        omittedFileCount: 0,
        files: [
          {
            id: "file-1",
            path: "src/app.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            renderState: "renderable",
            patch,
          },
        ],
      },
    ],
  };
}

describe("session diff routes", () => {
  it("bounds streaming bundle and failure bodies before parsing", async () => {
    const sessionName = `diff-body-limit-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-body-limit-token", sandboxId: "sandbox-body-limit" };
    await seedSandboxAuth(stub, auth);
    const headers = {
      Authorization: `Bearer ${auth.authToken}`,
      "Content-Type": "application/json",
    };

    expect(
      (
        await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
          method: "PUT",
          headers,
          body: " ".repeat(SESSION_DIFF_UPLOAD_BODY_MAX_BYTES + 1),
        })
      ).status
    ).toBe(413);
    expect(
      (
        await SELF.fetch(`https://test.local/sessions/${sessionName}/diff/failure`, {
          method: "POST",
          headers,
          body: " ".repeat(SESSION_DIFF_FAILURE_BODY_MAX_BYTES + 1),
        })
      ).status
    ).toBe(413);
  });

  it("requires the current sandbox token for writes", async () => {
    const sessionName = `diff-auth-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const baseSha = "a".repeat(40);
    await reportReady(stub, [{ position: 0, repoOwner: "acme", repoName: "web-app", baseSha }]);

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bundle(baseSha)),
    });

    expect(response.status).toBe(401);
  });

  it("stores one atomic bundle and serves public metadata plus a revision-pinned patch", async () => {
    const sessionName = `diff-store-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-store-token", sandboxId: "sandbox-store" };
    await seedSandboxAuth(stub, auth);
    const baseSha = "a".repeat(40);
    const patch = "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
    await reportReady(stub, [{ position: 0, repoOwner: "acme", repoName: "web-app", baseSha }]);

    const upload = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${auth.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bundle(baseSha, patch)),
    });
    expect(upload.status).toBe(200);
    const { revisionId } = await upload.json<{ revisionId: string }>();

    const rows = await queryDO<{ bundle_json: string }>(
      stub,
      "SELECT bundle_json FROM session_diff"
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.bundle_json).repositories[0].files[0].patch).toBe(patch);

    const authHeaders = await internalAuthHeaders();
    const stateResponse = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      headers: authHeaders,
    });
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json<Record<string, unknown>>();
    expect(state).toMatchObject({
      version: 1,
      current: {
        revisionId,
        repositories: [{ status: "ready", files: [{ id: "file-1", path: "src/app.ts" }] }],
      },
      lastError: null,
      unavailableReason: null,
    });
    expect(JSON.stringify(state)).not.toContain("diff --git");

    const file = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff/${revisionId}/files/file-1`,
      { headers: authHeaders }
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toContain("text/x-diff");
    await expect(file.text()).resolves.toBe(patch);

    const stale = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff/old-revision/files/file-1`,
      { headers: authHeaders }
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: "diff_revision_stale",
      currentRevisionId: revisionId,
    });
  });

  it("retains the prior success when a later refresh fails", async () => {
    const sessionName = `diff-failure-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-failure-token", sandboxId: "sandbox-failure" };
    await seedSandboxAuth(stub, auth);
    const baseSha = "c".repeat(40);
    await reportReady(stub, [{ position: 0, repoOwner: "acme", repoName: "web-app", baseSha }]);
    const headers = {
      Authorization: `Bearer ${auth.authToken}`,
      "Content-Type": "application/json",
    };
    const uploaded = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      method: "PUT",
      headers,
      body: JSON.stringify(bundle(baseSha)),
    });
    const { revisionId } = await uploaded.json<{ revisionId: string }>();

    expect(
      (
        await SELF.fetch(`https://test.local/sessions/${sessionName}/diff/failure`, {
          method: "POST",
          headers,
          body: JSON.stringify({ error: "git timed out" }),
        })
      ).status
    ).toBe(204);

    const state = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      headers: await internalAuthHeaders(),
    });
    await expect(state.json()).resolves.toMatchObject({
      current: { revisionId },
      lastError: { message: "git timed out" },
    });
  });

  it("validates repository membership and immutable baselines", async () => {
    const sessionName = `diff-membership-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-membership-token", sandboxId: "sandbox-membership" };
    await seedSandboxAuth(stub, auth);
    const baseSha = "d".repeat(40);
    await reportReady(stub, [{ position: 0, repoOwner: "acme", repoName: "web-app", baseSha }]);
    const headers = {
      Authorization: `Bearer ${auth.authToken}`,
      "Content-Type": "application/json",
    };

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      method: "PUT",
      headers,
      body: JSON.stringify(bundle("e".repeat(40))),
    });
    expect(response.status).toBe(400);
  });

  it("stores one coherent partial multi-repository revision", async () => {
    const sessionName = `diff-partial-${Date.now()}`;
    const repositories = [
      { repoOwner: "acme", repoName: "web-app", repoId: 1, baseBranch: "main" },
      { repoOwner: "group/subgroup", repoName: "api", repoId: 2, baseBranch: "main" },
    ];
    const { stub } = await initNamedSession(sessionName, {
      repoOwner: "acme",
      repoName: "web-app",
      repoId: 1,
      defaultBranch: "main",
      repositories,
    });
    const auth = { authToken: "diff-partial-token", sandboxId: "sandbox-partial" };
    await seedSandboxAuth(stub, auth);
    const firstSha = "1".repeat(40);
    const secondSha = "2".repeat(40);
    await reportReady(stub, [
      { position: 0, repoOwner: "acme", repoName: "web-app", baseSha: firstSha },
      { position: 1, repoOwner: "group/subgroup", repoName: "api", baseSha: secondSha },
    ]);
    const partial = bundle(firstSha);
    partial.repositories.push({
      status: "unavailable" as "ready",
      position: 1,
      repoOwner: "group/subgroup",
      repoName: "api",
      baseSha: secondSha,
      error: "start commit missing",
      files: [],
    } as unknown as (typeof partial.repositories)[number]);

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${auth.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(partial),
    });
    expect(response.status).toBe(200);
    const state = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      headers: await internalAuthHeaders(),
    });
    await expect(state.json()).resolves.toMatchObject({
      current: {
        repositories: [
          { status: "ready" },
          { status: "unavailable", error: "start commit missing", files: [] },
        ],
      },
    });
  });

  it("sends retry as a small refresh command without capture state", async () => {
    const sessionName = `diff-retry-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-retry-token", sandboxId: "sandbox-retry" };
    await seedSandboxAuth(stub, auth);
    const { ws } = await openSandboxWs(sessionName, auth);
    expect(ws).not.toBeNull();
    ws!.accept();
    const messages = collectMessages(ws!, {
      until: (message) => message.type === "refresh_diff",
      timeoutMs: 2_000,
    });

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff/retry`, {
      method: "POST",
      headers: await internalAuthHeaders(),
    });

    expect(response.status).toBe(202);
    expect(await messages).toContainEqual({ type: "refresh_diff" });
    ws!.close(1000, "done");
  });
});
