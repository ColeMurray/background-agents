import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { initNamedSession, queryDO, seedMessage, seedSandboxAuthHash } from "./helpers";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

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

function buildVideoUploadForm(): FormData {
  const formData = new FormData();
  formData.append("file", new File([MP4_BYTES], "recording.mp4", { type: "video/mp4" }));
  formData.append("artifactType", "video");
  formData.append("caption", "Settings menu opens");
  formData.append("durationMs", "2500");
  formData.append("recordingStartedAt", "1000");
  formData.append("recordingEndedAt", "3500");
  formData.append("dimensions", '{"width":1280,"height":720}');
  formData.append("truncated", "false");
  formData.append("hasAudio", "false");
  return formData;
}

async function uploadVideo(sessionName: string, token: string) {
  const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: buildVideoUploadForm(),
  });
  if (response.status !== 201) {
    throw new Error(`Video upload failed: ${response.status}`);
  }
  return response.json<{ artifactId: string; objectKey: string }>();
}

describe("session media routes", () => {
  it("uploads a prompt attachment with internal auth and stores it in R2", async () => {
    const sessionName = `attachment-upload-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: "sandbox-attachment-token",
      sandboxId: "sandbox-1",
    });
    const bytes = new TextEncoder().encode("quarter,revenue\nQ1,100\n");

    const formData = new FormData();
    formData.append("file", new File([bytes], "../report.csv", { type: "text/csv" }));

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/attachments`, {
      method: "POST",
      headers: await internalAuthHeaders(),
      body: formData,
    });

    expect(response.status).toBe(201);
    const body = await response.json<{
      attachment: {
        id: string;
        type: string;
        name: string;
        url: string;
        mimeType: string;
        sizeBytes: number;
        objectKey: string;
      };
    }>();
    expect(body.attachment).toMatchObject({
      type: "file",
      name: "report.csv",
      mimeType: "text/csv",
      sizeBytes: bytes.byteLength,
    });
    expect(body.attachment.objectKey).toBe(
      `sessions/${sessionName}/attachments/${body.attachment.id}/report.csv`
    );
    expect(body.attachment.url).toBe(
      `/sessions/${sessionName}/attachments/${body.attachment.id}?filename=report.csv`
    );

    const object = await env.MEDIA_BUCKET.get(body.attachment.objectKey);
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe("text/csv");

    const downloadResponse = await SELF.fetch(`https://test.local${body.attachment.url}`, {
      headers: {
        Authorization: "Bearer sandbox-attachment-token",
      },
    });
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("Content-Type")).toBe("text/csv");
    expect(downloadResponse.headers.get("Content-Disposition")).toContain("report.csv");
    expect(await downloadResponse.text()).toBe("quarter,revenue\nQ1,100\n");
  });

  it("rejects unsupported prompt attachment types", async () => {
    const sessionName = `attachment-unsupported-${Date.now()}`;
    await initNamedSession(sessionName);

    const formData = new FormData();
    formData.append("file", new File([new Uint8Array([1, 2, 3])], "payload.bin"));

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/attachments`, {
      method: "POST",
      headers: await internalAuthHeaders(),
      body: formData,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unsupported attachment file type",
    });
  });

  it("rejects uploads without authentication", async () => {
    const sessionName = `media-unauthorized-${Date.now()}`;
    await initNamedSession(sessionName);

    const formData = new FormData();
    formData.append("file", new File([PNG_SIGNATURE], "shot.png", { type: "image/png" }));
    formData.append("artifactType", "screenshot");

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

  it("uploads a video and persists it on the active prompt", async () => {
    const sessionName = `media-video-upload-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: "sandbox-video-token",
      sandboxId: "sandbox-1",
    });
    await seedProcessingMessage(stub, "msg-1");

    const formData = new FormData();
    formData.append("file", new File([MP4_BYTES], "recording.mp4", { type: "video/mp4" }));
    formData.append("artifactType", "video");
    formData.append("caption", "Settings menu opens");
    formData.append("durationMs", "2500");
    formData.append("recordingStartedAt", "1000");
    formData.append("recordingEndedAt", "3500");
    formData.append("dimensions", '{"width":1280,"height":720}');
    formData.append("truncated", "false");
    formData.append("hasAudio", "false");

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/media`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-video-token",
      },
      body: formData,
    });

    expect(response.status).toBe(201);
    const body = await response.json<{
      artifactId: string;
      objectKey: string;
    }>();
    expect(body.artifactId).toBeTruthy();
    expect(body.objectKey).toBe(`sessions/${sessionName}/media/${body.artifactId}.mp4`);

    const object = await env.MEDIA_BUCKET.get(body.objectKey);
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe("video/mp4");

    const artifacts = await queryDO<{ id: string; type: string; url: string; metadata: string }>(
      stub,
      "SELECT id, type, url, metadata FROM artifacts WHERE id = ?",
      body.artifactId
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: body.artifactId,
      type: "video",
      url: body.objectKey,
    });
    expect(JSON.parse(artifacts[0].metadata)).toMatchObject({
      objectKey: body.objectKey,
      mimeType: "video/mp4",
      sizeBytes: MP4_BYTES.byteLength,
      caption: "Settings menu opens",
      durationMs: 2500,
      dimensions: { width: 1280, height: 720 },
      truncated: false,
      hasAudio: false,
      captureSurface: "browser",
      source: "agent",
    });

    const events = await queryDO<{ type: string; message_id: string; data: string }>(
      stub,
      "SELECT type, message_id, data FROM events WHERE type = 'artifact'"
    );
    expect(events).toHaveLength(1);
    expect(events[0].message_id).toBe("msg-1");
    expect(JSON.parse(events[0].data)).toMatchObject({
      type: "artifact",
      artifactType: "video",
      artifactId: body.artifactId,
      messageId: "msg-1",
      url: body.objectKey,
    });
  });

  it("rejects uploads when no prompt is active", async () => {
    const sessionName = `media-no-prompt-${Date.now()}`;
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

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "No active prompt" });

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

  it("streams a stored video artifact from the worker", async () => {
    const sessionName = `media-video-stream-${Date.now()}`;
    const token = "sandbox-video-stream-token";
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: token,
      sandboxId: "sandbox-1",
    });
    await seedProcessingMessage(stub, "msg-1");

    const uploadBody = await uploadVideo(sessionName, token);

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/media/${uploadBody.artifactId}`,
      {
        headers: await internalAuthHeaders(),
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Length")).toBe(String(MP4_BYTES.byteLength));
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(MP4_BYTES));
  });

  it("streams byte ranges for video artifacts", async () => {
    const sessionName = `media-video-range-${Date.now()}`;
    const token = "sandbox-video-range-token";
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: token,
      sandboxId: "sandbox-1",
    });
    await seedProcessingMessage(stub, "msg-1");

    const uploadBody = await uploadVideo(sessionName, token);

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/media/${uploadBody.artifactId}`,
      {
        headers: {
          ...(await internalAuthHeaders()),
          Range: "bytes=4-11",
        },
      }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe(`bytes 4-11/${MP4_BYTES.byteLength}`);
    expect(response.headers.get("Content-Length")).toBe("8");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(MP4_BYTES.slice(4, 12))
    );
  });

  it("rejects malformed multi-hyphen byte ranges for video artifacts", async () => {
    const sessionName = `media-video-bad-range-${Date.now()}`;
    const token = "sandbox-video-bad-range-token";
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: token,
      sandboxId: "sandbox-1",
    });
    await seedProcessingMessage(stub, "msg-1");

    const uploadBody = await uploadVideo(sessionName, token);

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/media/${uploadBody.artifactId}`,
      {
        headers: {
          ...(await internalAuthHeaders()),
          Range: "bytes=1-2-3",
        },
      }
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${MP4_BYTES.byteLength}`);
    await expect(response.json()).resolves.toEqual({ error: "Requested range is not satisfiable" });
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
