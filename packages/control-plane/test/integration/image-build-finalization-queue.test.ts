import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import worker from "../../src/index";
import { ImageBuildStore } from "../../src/db/image-builds";
import { cleanD1Tables } from "./cleanup";
import { environmentScope, getRow, seedEnvironment } from "./image-build-helpers";

const QUEUE_NAME = "image-build-finalization-test";
const COMPLETION_HASH = "a".repeat(64);

async function seedAcceptedBuild(buildId: string): Promise<ImageBuildStore> {
  const environmentId = await seedEnvironment();
  const store = new ImageBuildStore(env.DB);
  const now = Date.now();
  await store.registerBuild({
    id: buildId,
    scope: environmentScope(environmentId),
    provider: "modal",
    repositoriesFingerprint: "fingerprint-1",
    callbackTokenHash: "token-hash",
    callbackTokenExpiresAt: now + 60_000,
  });
  await store.bindProviderSession(buildId, "modal", `session-${buildId}`);
  await store.finalization.acceptSuccessfulCompletion({
    buildId,
    provider: "modal",
    providerSessionId: `session-${buildId}`,
    tokenHash: "token-hash",
    completionHash: COMPLETION_HASH,
    repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
    runtimeVersion: "v53-runtime",
    buildDurationSeconds: 1,
    now,
  });
  return store;
}

function finalizationBatch(messageId: string, buildId: string) {
  return createMessageBatch(QUEUE_NAME, [
    {
      id: messageId,
      timestamp: new Date(),
      attempts: 1,
      body: { version: 1 as const, buildId, completionHash: COMPLETION_HASH },
    },
  ]);
}

describe("image build finalization Queue integration", () => {
  beforeEach(cleanD1Tables);

  it("resumes a fenced artifact through the Worker Queue entrypoint without snapshotting again", async () => {
    const buildId = "queue-resume";
    const store = await seedAcceptedBuild(buildId);
    const now = Date.now();
    await store.finalization.claimLease({
      buildId,
      completionHash: COMPLETION_HASH,
      leaseToken: "crashed-consumer",
      now,
      expiresAt: now + 1,
    });
    await store.finalization.recordArtifact({
      buildId,
      provider: "modal",
      providerSessionId: `session-${buildId}`,
      completionHash: COMPLETION_HASH,
      leaseToken: "crashed-consumer",
      providerImageId: "image-already-created",
    });
    // Model a crash after fencing the provider artifact. Cleanup completed
    // independently, so the resumed consumer needs no external provider call.
    await env.DB.prepare(
      `UPDATE image_builds
       SET finalization_lease_expires_at = 0, provider_session_cleanup_pending = 0
       WHERE id = ?`
    )
      .bind(buildId)
      .run();

    const batch = finalizationBatch("queue-message-resume", buildId);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const queueResult = await getQueueResult(batch, ctx);

    expect(queueResult.explicitAcks).toEqual(["queue-message-resume"]);
    expect(queueResult.retryMessages).toEqual([]);
    expect(await getRow(buildId)).toMatchObject({
      status: "ready",
      provider_image_id: "image-already-created",
      finalization_lease_token: null,
      finalization_lease_expires_at: null,
    });
  });

  it("retries an actual Queue message while another consumer owns the D1 lease", async () => {
    const buildId = "queue-busy";
    const store = await seedAcceptedBuild(buildId);
    const now = Date.now();
    await store.finalization.claimLease({
      buildId,
      completionHash: COMPLETION_HASH,
      leaseToken: "active-consumer",
      now,
      expiresAt: now + 60_000,
    });

    const batch = finalizationBatch("queue-message-busy", buildId);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const queueResult = await getQueueResult(batch, ctx);

    expect(queueResult.explicitAcks).toEqual([]);
    expect(queueResult.retryMessages).toHaveLength(1);
    expect(queueResult.retryMessages[0]).toMatchObject({
      msgId: "queue-message-busy",
    });
    expect(await getRow(buildId)).toMatchObject({
      status: "building",
      finalization_lease_token: "active-consumer",
    });
  });
});
