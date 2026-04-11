import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { initNamedSession, queryDO, seedMessage, seedSandboxAuthHash } from "./helpers";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function internalAuthHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}` };
}

async function seedProcessingMessage(
  stub: DurableObjectStub,
  messageId: string,
  userId = "user-1"
): Promise<void> {
  const participants = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants WHERE user_id = ?",
    userId
  );
  const participantId = participants[0]?.id;
  if (!participantId) {
    throw new Error(`Missing participant for user ${userId}`);
  }

  await seedMessage(stub, {
    id: messageId,
    authorId: participantId,
    content: "Capture a screenshot",
    source: "sandbox",
    status: "processing",
    createdAt: Date.now() - 1_000,
    startedAt: Date.now() - 500,
  });
}

describe("session media routes", () => {
  it("uploads a screenshot, stores it in R2, and persists artifact + event rows", async () => {
    const sessionName = `media-upload-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: "sandbox-upload-token",
      sandboxId: "sandbox-1",
    });
    await seedProcessingMessage(stub, "msg-1");

    const formData = new FormData();
    formData.append("file", new File([PNG_SIGNATURE], "shot.png", { type: "image/png" }));
    formData.append("artifactType", "screenshot");
    formData.append("messageId", "msg-1");
    formData.append("caption", "Dashboard after fix");
    formData.append("fullPage", "true");

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/media`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-upload-token",
      },
      body: formData,
    });

    expect(response.status).toBe(201);
    const body = await response.json<{ artifactId: string; objectKey: string }>();
    expect(body.artifactId).toBeTruthy();
    expect(body.objectKey).toBe(`sessions/${sessionName}/media/${body.artifactId}.png`);

    const object = await env.MEDIA_BUCKET.get(body.objectKey);
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe("image/png");

    const artifacts = await queryDO<{ id: string; type: string; url: string; metadata: string }>(
      stub,
      "SELECT id, type, url, metadata FROM artifacts WHERE id = ?",
      body.artifactId
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: body.artifactId,
      type: "screenshot",
      url: body.objectKey,
    });
    expect(JSON.parse(artifacts[0].metadata)).toEqual({
      objectKey: body.objectKey,
      mimeType: "image/png",
      sizeBytes: PNG_SIGNATURE.byteLength,
      fullPage: true,
      caption: "Dashboard after fix",
    });

    const events = await queryDO<{ type: string; message_id: string; data: string }>(
      stub,
      "SELECT type, message_id, data FROM events WHERE type = 'artifact'"
    );
    expect(events).toHaveLength(1);
    expect(events[0].message_id).toBe("msg-1");
    expect(JSON.parse(events[0].data)).toMatchObject({
      type: "artifact",
      artifactType: "screenshot",
      artifactId: body.artifactId,
      messageId: "msg-1",
      url: body.objectKey,
    });
  });

  it("rejects uploads without a messageId", async () => {
    const sessionName = `media-missing-message-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: "sandbox-upload-token-2",
      sandboxId: "sandbox-1",
    });

    const formData = new FormData();
    formData.append("file", new File([PNG_SIGNATURE], "shot.png", { type: "image/png" }));
    formData.append("artifactType", "screenshot");

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/media`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-upload-token-2",
      },
      body: formData,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "messageId is required" });
  });

  it("rejects uploads for stale or foreign message ids", async () => {
    const sessionName = `media-stale-message-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: "sandbox-upload-token-stale",
      sandboxId: "sandbox-1",
    });
    await seedProcessingMessage(stub, "msg-active");

    const formData = new FormData();
    formData.append("file", new File([PNG_SIGNATURE], "shot.png", { type: "image/png" }));
    formData.append("artifactType", "screenshot");
    formData.append("messageId", "msg-stale");

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/media`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-upload-token-stale",
      },
      body: formData,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "messageId must match the active prompt",
    });

    const artifacts = await queryDO<{ id: string }>(stub, "SELECT id FROM artifacts");
    expect(artifacts).toHaveLength(0);

    const events = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM events WHERE type = 'artifact'"
    );
    expect(events).toHaveLength(0);
  });

  it("returns a presigned URL for a stored screenshot artifact", async () => {
    const sessionName = `media-presign-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: "sandbox-upload-token-3",
      sandboxId: "sandbox-1",
    });
    await seedProcessingMessage(stub, "msg-1");

    const uploadForm = new FormData();
    uploadForm.append("file", new File([PNG_SIGNATURE], "shot.png", { type: "image/png" }));
    uploadForm.append("artifactType", "screenshot");
    uploadForm.append("messageId", "msg-1");

    const uploadResponse = await SELF.fetch(`https://test.local/sessions/${sessionName}/media`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-upload-token-3",
      },
      body: uploadForm,
    });
    const uploadBody = await uploadResponse.json<{ artifactId: string; objectKey: string }>();

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/media/${uploadBody.artifactId}`,
      {
        headers: await internalAuthHeaders(),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ url: string; expiresAt: number }>();
    expect(body.url).toContain(
      `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${uploadBody.objectKey}`
    );
    expect(body.url).toContain("X-Amz-Signature=");
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
