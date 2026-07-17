import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { generateInternalToken } from "../../src/auth/internal";
import {
  SESSION_DIFF_COMPLETE_BODY_MAX_BYTES,
  SESSION_DIFF_FAILURE_BODY_MAX_BYTES,
} from "../../src/routes/session-diffs";
import {
  collectMessages,
  initNamedSession,
  openSandboxWs,
  queryDO,
  seedMessage,
  seedSandboxAuth,
} from "./helpers";

async function internalAuthHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}` };
}

describe("session diff routes", () => {
  it("rejects oversized capture completion and failure bodies before parsing", async () => {
    const sessionName = `diff-body-limit-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-body-limit-token", sandboxId: "sandbox-body-limit" };
    await seedSandboxAuth(stub, auth);
    const headers = {
      Authorization: `Bearer ${auth.authToken}`,
      "Content-Type": "application/json",
    };

    const complete = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff-captures/capture-limit/complete`,
      {
        method: "POST",
        headers,
        body: " ".repeat(SESSION_DIFF_COMPLETE_BODY_MAX_BYTES + 1),
      }
    );
    expect(complete.status).toBe(413);

    const failed = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff-captures/capture-limit/failed`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ error: "x".repeat(SESSION_DIFF_FAILURE_BODY_MAX_BYTES) }),
      }
    );
    expect(failed.status).toBe(413);
  });

  it("exposes a pending diff state for a newly initialized repository session", async () => {
    const sessionName = `diff-pending-${Date.now()}`;
    await initNamedSession(sessionName);

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      headers: await internalAuthHeaders(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 1,
      baseline: { status: "pending", reason: null },
      attempt: { id: null, status: "idle", startedAt: null, error: null },
      current: null,
    });
  });

  it("records the first runtime baselines before work is dispatched", async () => {
    const sessionName = `diff-baseline-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const baseSha = "a".repeat(40);

    const ready = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: "sandbox-1",
        timestamp: 100,
        capabilities: ["session_diff_v1"],
        repositories: [
          {
            position: 0,
            repoOwner: "acme",
            repoName: "web-app",
            baseSha,
          },
        ],
      }),
    });

    expect(ready.status).toBe(200);
    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      headers: await internalAuthHeaders(),
    });
    await expect(response.json()).resolves.toMatchObject({
      baseline: { status: "ready", reason: null },
    });
    const repositories = await queryDO<{ base_sha: string }>(
      stub,
      "SELECT base_sha FROM session_repositories ORDER BY position"
    );
    expect(repositories).toEqual([{ base_sha: baseSha }]);
    const session = await queryDO<{ base_sha: string }>(stub, "SELECT base_sha FROM session");
    expect(session).toEqual([{ base_sha: baseSha }]);
  });

  it("starts one capture command at the terminal execution boundary", async () => {
    const sessionName = `diff-capture-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-sandbox-token", sandboxId: "sandbox-diff-1" };
    await seedSandboxAuth(stub, auth);
    const { ws } = await openSandboxWs(sessionName, auth);
    expect(ws).not.toBeNull();
    ws!.accept();

    const baseSha = "b".repeat(40);
    ws!.send(
      JSON.stringify({
        type: "ready",
        sandboxId: auth.sandboxId,
        timestamp: 100,
        capabilities: ["session_diff_v1"],
        repositories: [
          {
            position: 0,
            repoOwner: "acme",
            repoName: "web-app",
            baseSha,
          },
        ],
      })
    );

    const participants = await queryDO<{ id: string }>(stub, "SELECT id FROM participants LIMIT 1");
    await seedMessage(stub, {
      id: "message-1",
      authorId: participants[0]!.id,
      content: "Make the change",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 500,
    });

    const commandsPromise = collectMessages(ws!, {
      until: (message) => message.type === "capture_diff",
      timeoutMs: 2_000,
    });
    ws!.send(
      JSON.stringify({
        type: "execution_complete",
        messageId: "message-1",
        success: true,
        sandboxId: auth.sandboxId,
        timestamp: 200,
        ackId: "execution_complete:message-1",
      })
    );

    const commands = await commandsPromise;
    const capture = commands.find((message) => message.type === "capture_diff");
    expect(capture).toMatchObject({
      baselines: [{ position: 0, repoOwner: "acme", repoName: "web-app", baseSha }],
      limits: { maxFiles: 1000 },
    });
    const diffState = await queryDO<{ attempt_status: string; attempt_id: string }>(
      stub,
      "SELECT attempt_status, attempt_id FROM diff_state"
    );
    expect(diffState).toEqual([{ attempt_status: "capturing", attempt_id: expect.any(String) }]);
    ws!.close(1000, "done");
  });

  it("stages a bounded patch, atomically publishes its manifest, and serves revision-pinned content", async () => {
    const sessionName = `diff-publish-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-upload-token", sandboxId: "sandbox-diff-upload" };
    await seedSandboxAuth(stub, auth);
    const baseSha = "c".repeat(40);
    const captureId = "capture-publish-1";
    const fileId = "file-publish-1";
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-const value = 1;",
      "+const value = 2;",
      "",
    ].join("\n");

    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: auth.sandboxId,
        timestamp: 100,
        capabilities: ["session_diff_v1"],
        repositories: [{ position: 0, repoOwner: "acme", repoName: "web-app", baseSha }],
      }),
    });
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE diff_state
         SET attempt_id = ?, attempt_trigger_message_id = ?, attempt_status = 'capturing',
             attempt_started_at = ?, updated_at = ?
         WHERE singleton = 1`,
        captureId,
        "message-publish-1",
        200,
        200
      );
    });

    const upload = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff-captures/${captureId}/files/${fileId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${auth.authToken}`,
          "Content-Type": "text/x-diff; charset=utf-8",
        },
        body: patch,
      }
    );
    expect(upload.status).toBe(201);

    const complete = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff-captures/${captureId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repositories: [
            {
              position: 0,
              repoOwner: "acme",
              repoName: "web-app",
              baseSha,
              headSha: "d".repeat(40),
              truncated: false,
              omittedFileCount: 0,
              files: [
                {
                  id: fileId,
                  path: "src/app.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  renderState: "renderable",
                  patchBytes: new TextEncoder().encode(patch).byteLength,
                },
              ],
            },
          ],
        }),
      }
    );
    expect(complete.status).toBe(200);

    const internalHeaders = await internalAuthHeaders();
    const stateResponse = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      headers: internalHeaders,
    });
    const state = await stateResponse.json<Record<string, unknown>>();
    expect(state).toMatchObject({
      attempt: { id: captureId, status: "idle", error: null },
      current: {
        revisionId: captureId,
        triggerMessageId: "message-publish-1",
        repositories: [
          {
            status: "ready",
            sourceCaptureId: captureId,
            files: [{ id: fileId, path: "src/app.ts" }],
          },
        ],
      },
    });
    expect(JSON.stringify(state)).not.toContain("objectKey");

    const fileResponse = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff/${captureId}/files/${fileId}`,
      { headers: internalHeaders }
    );
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.headers.get("cache-control")).toBe("private, no-store");
    await expect(fileResponse.text()).resolves.toBe(patch);

    const staleResponse = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff/stale-revision/files/${fileId}`,
      { headers: internalHeaders }
    );
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({
      code: "diff_revision_stale",
      currentRevisionId: captureId,
    });
  });

  it("rejects duplicate-path captures without poisoning the readable state", async () => {
    const sessionName = `diff-duplicate-path-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const auth = { authToken: "diff-duplicate-token", sandboxId: "sandbox-duplicate" };
    await seedSandboxAuth(stub, auth);
    const baseSha = "7".repeat(40);
    const captureId = "capture-duplicate-path";
    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: auth.sandboxId,
        timestamp: 100,
        capabilities: ["session_diff_v1"],
        repositories: [{ position: 0, repoOwner: "acme", repoName: "web-app", baseSha }],
      }),
    });
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE diff_state
         SET attempt_id = ?, attempt_trigger_message_id = ?, attempt_status = 'capturing',
             attempt_started_at = ?, updated_at = ?
         WHERE singleton = 1`,
        captureId,
        "message-duplicate-path",
        200,
        200
      );
    });

    const complete = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/diff-captures/${captureId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repositories: [
            {
              position: 0,
              repoOwner: "acme",
              repoName: "web-app",
              baseSha,
              headSha: "8".repeat(40),
              truncated: false,
              omittedFileCount: 0,
              files: [
                {
                  id: "deleted-file",
                  path: "src/app.ts",
                  status: "deleted",
                  additions: 0,
                  deletions: 1,
                  renderState: "metadata_only",
                },
                {
                  id: "untracked-file",
                  path: "src/app.ts",
                  status: "added",
                  additions: 1,
                  deletions: 0,
                  renderState: "metadata_only",
                },
              ],
            },
          ],
        }),
      }
    );

    expect(complete.status).toBe(400);
    const stateResponse = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      headers: await internalAuthHeaders(),
    });
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toMatchObject({
      attempt: { id: captureId, status: "capturing" },
      current: null,
    });
  });

  it("publishes successful repositories while preserving prior data as stale on later partial failures", async () => {
    const sessionName = `diff-partial-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName, {
      repoOwner: "acme",
      repoName: "web",
      repoId: 1,
      repositories: [
        { repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
      ],
    });
    const auth = { authToken: "diff-partial-token", sandboxId: "sandbox-partial" };
    await seedSandboxAuth(stub, auth);
    const baselines = ["e".repeat(40), "f".repeat(40)];
    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: auth.sandboxId,
        timestamp: 100,
        capabilities: ["session_diff_v1"],
        repositories: [
          { position: 0, repoOwner: "acme", repoName: "web", baseSha: baselines[0] },
          { position: 1, repoOwner: "acme", repoName: "api", baseSha: baselines[1] },
        ],
      }),
    });

    const publish = async (captureId: string, outcomes: unknown[]) => {
      await runInDurableObject(stub, (instance: SessionDO) => {
        instance.ctx.storage.sql.exec(
          `UPDATE diff_state SET attempt_id = ?, attempt_trigger_message_id = ?,
             attempt_status = 'capturing', attempt_started_at = 200, updated_at = 200
           WHERE singleton = 1`,
          captureId,
          `message-${captureId}`
        );
      });
      return SELF.fetch(
        `https://test.local/sessions/${sessionName}/diff-captures/${captureId}/complete`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ repositories: outcomes }),
        }
      );
    };
    const success = (position: number, repoName: string) => ({
      position,
      repoOwner: "acme",
      repoName,
      baseSha: baselines[position],
      headSha: String(position + 1).repeat(40),
      truncated: false,
      omittedFileCount: 0,
      files: [],
    });
    const failure = (position: number, repoName: string) => ({
      position,
      repoOwner: "acme",
      repoName,
      baseSha: baselines[position],
      error: `${repoName} unavailable`,
    });

    expect(
      (await publish("capture-partial-1", [success(0, "web"), failure(1, "api")])).status
    ).toBe(200);
    expect(
      (await publish("capture-partial-2", [failure(0, "web"), success(1, "api")])).status
    ).toBe(200);

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/diff`, {
      headers: await internalAuthHeaders(),
    });
    await expect(response.json()).resolves.toMatchObject({
      current: {
        revisionId: "capture-partial-2",
        repositories: [
          { position: 0, status: "stale", sourceCaptureId: "capture-partial-1" },
          { position: 1, status: "ready", sourceCaptureId: "capture-partial-2" },
        ],
      },
    });
  });

  it("tombstones diff capture before session deletion cleanup", async () => {
    const sessionName = `diff-delete-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    const baseSha = "9".repeat(40);
    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: "sandbox-delete",
        timestamp: 100,
        capabilities: ["session_diff_v1"],
        repositories: [{ position: 0, repoOwner: "acme", repoName: "web-app", baseSha }],
      }),
    });
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE diff_state SET attempt_id = 'capture-delete', attempt_status = 'capturing',
           attempt_started_at = 200, updated_at = 200 WHERE singleton = 1`
      );
    });

    expect(
      (await stub.fetch("http://internal/internal/diff-delete", { method: "POST" })).status
    ).toBe(204);
    const lateStage = await stub.fetch("http://internal/internal/diff-stage-object", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        captureId: "capture-delete",
        fileId: "late-file",
        sizeBytes: 10,
        sha256: "a".repeat(64),
      }),
    });
    expect(lateStage.status).toBe(409);
    const state = await queryDO<{
      deleted_at: number;
      baseline_status: string;
      ready_manifest: string | null;
    }>(stub, "SELECT deleted_at, baseline_status, ready_manifest FROM diff_state");
    expect(state).toEqual([
      {
        deleted_at: expect.any(Number),
        baseline_status: "unavailable",
        ready_manifest: null,
      },
    ]);
  });
});
