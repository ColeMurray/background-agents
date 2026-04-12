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
  it("rejects uploads without authentication", async () => {
    const sessionName = `media-unauthorized-${Date.now()}`;
    await initNamedSession(sessionName);

    const formData = new FormData();
    formData.append("file", new File([PNG_SIGNATURE], "shot.png", { type: "image/png" }));
    formData.append("artifactType", "screenshot");
    formData.append("messageId", "msg-1");

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/media`, {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized: Missing sandbox token",
    });
  });

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

  it("streams a stored screenshot artifact from the worker", async () => {
    const sessionName = `media-stream-${Date.now()}`;
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
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(PNG_SIGNATURE.byteLength));
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(PNG_SIGNATURE)
    );
  });

  it("returns 404 when the screenshot object is missing from R2", async () => {
    const sessionName = `media-missing-object-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: "sandbox-upload-token-4",
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
        Authorization: "Bearer sandbox-upload-token-4",
      },
      body: uploadForm,
    });
    const uploadBody = await uploadResponse.json<{ artifactId: string; objectKey: string }>();

    await env.MEDIA_BUCKET.delete(uploadBody.objectKey);

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/media/${uploadBody.artifactId}`,
      {
        headers: await internalAuthHeaders(),
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Media artifact not found" });
  });

  it("falls back to the R2 object's content type when artifact metadata is incomplete", async () => {
    const sessionName = `media-object-metadata-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedProcessingMessage(stub, "msg-1");

    const objectKey = `sessions/${sessionName}/media/artifact-legacy.png`;
    await env.MEDIA_BUCKET.put(objectKey, PNG_SIGNATURE, {
      httpMetadata: { contentType: "image/png" },
    });

    const createArtifactResponse = await stub.fetch(
      "http://internal/internal/create-media-artifact",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId: "artifact-legacy",
          artifactType: "screenshot",
          objectKey,
          messageId: "msg-1",
          metadata: {
            objectKey,
            sizeBytes: PNG_SIGNATURE.byteLength,
          },
        }),
      }
    );
    expect(createArtifactResponse.status).toBe(200);

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/media/artifact-legacy`,
      {
        headers: await internalAuthHeaders(),
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(PNG_SIGNATURE)
    );
  });

  it("returns 404 for non-screenshot artifacts", async () => {
    const sessionName = `media-wrong-type-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedProcessingMessage(stub, "msg-1");

    const createArtifactResponse = await stub.fetch(
      "http://internal/internal/create-media-artifact",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId: "artifact-branch",
          artifactType: "branch",
          objectKey: "sessions/session-1/media/artifact-branch.txt",
          messageId: "msg-1",
        }),
      }
    );
    expect(createArtifactResponse.status).toBe(200);

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/media/artifact-branch`,
      {
        headers: await internalAuthHeaders(),
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Media artifact not found" });
  });
});
