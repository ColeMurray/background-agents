import { describe, expect, it, vi } from "vitest";
import {
  PROMPT_UPLOAD_LIMIT_PER_SESSION,
  PROMPT_UPLOAD_IMAGE_MAX_BYTES,
  PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION,
  PROMPT_UPLOAD_UNREFERENCED_TTL_MS,
  PROMPT_UPLOAD_CLEANUP_CLAIM_TTL_MS,
} from "../../../media";
import type { SessionRow, UploadRow } from "../../types";
import { createUploadsHandler } from "./uploads.handler";

const NOW = 1_000_000_000;

function buildHandler(options?: {
  session?: SessionRow | null;
  totals?: { count: number; totalBytes: number };
  stale?: UploadRow[];
}) {
  const repository = {
    createUpload: vi.fn(),
    getUploadTotals: vi.fn(() => options?.totals ?? { count: 0, totalBytes: 0 }),
    claimStaleUnreferencedUploads: vi.fn(() => options?.stale ?? []),
    acknowledgeUploadCleanup: vi.fn(),
    releaseUploadCleanupClaims: vi.fn(),
  };

  const handler = createUploadsHandler({
    repository,
    getSession: () =>
      options && "session" in options ? options.session! : ({ id: "sess-1" } as SessionRow),
    getLog: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never,
    now: () => NOW,
  });

  return { handler, repository };
}

function uploadRequest(body: unknown): Request {
  return new Request("http://internal/internal/uploads", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  action: "record",
  uploadId: "up-1",
  mimeType: "image/png",
  sizeBytes: 1024,
  objectKey: "sessions/sess-1/uploads/up-1",
};

describe("createUploadsHandler", () => {
  it("returns 404 when the session is not initialized", async () => {
    const { handler, repository } = buildHandler({ session: null });

    const response = await handler.recordUpload(uploadRequest(VALID_BODY));

    expect(response.status).toBe(404);
    expect(repository.createUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["missing uploadId", { ...VALID_BODY, uploadId: "" }],
    ["invalid action", { ...VALID_BODY, action: "invalid" }],
    ["unsupported MIME type", { ...VALID_BODY, mimeType: "video/mp4" }],
    ["missing mimeType", { ...VALID_BODY, mimeType: "" }],
    ["non-positive size", { ...VALID_BODY, sizeBytes: 0 }],
    ["non-integer size", { ...VALID_BODY, sizeBytes: 1.5 }],
    ["oversized upload", { ...VALID_BODY, sizeBytes: PROMPT_UPLOAD_IMAGE_MAX_BYTES + 1 }],
    ["missing objectKey", { ...VALID_BODY, objectKey: "" }],
  ])("rejects %s with 400", async (_label, body) => {
    const { handler, repository } = buildHandler();

    const response = await handler.recordUpload(uploadRequest(body));

    expect(response.status).toBe(400);
    expect(repository.createUpload).not.toHaveBeenCalled();
  });

  it("rejects when the per-session file count cap is reached", async () => {
    const { handler, repository } = buildHandler({
      totals: { count: PROMPT_UPLOAD_LIMIT_PER_SESSION, totalBytes: 0 },
    });

    const response = await handler.recordUpload(uploadRequest(VALID_BODY));

    expect(response.status).toBe(429);
    expect(repository.createUpload).not.toHaveBeenCalled();
    expect(repository.claimStaleUnreferencedUploads).toHaveBeenCalledWith(
      NOW - PROMPT_UPLOAD_UNREFERENCED_TTL_MS,
      NOW,
      NOW - PROMPT_UPLOAD_CLEANUP_CLAIM_TTL_MS
    );
  });

  it("rejects when the upload would exceed the per-session byte cap", async () => {
    const { handler, repository } = buildHandler({
      totals: { count: 1, totalBytes: PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION - 512 },
    });

    const response = await handler.recordUpload(uploadRequest(VALID_BODY));

    expect(response.status).toBe(429);
    expect(repository.createUpload).not.toHaveBeenCalled();
  });

  it("prunes stale uploads before enforcing quota totals", async () => {
    const staleUpload: UploadRow = {
      id: "old-1",
      mime_type: "image/png",
      size_bytes: 1024,
      object_key: "sessions/sess-1/uploads/old-1",
      message_id: null,
      cleanup_claimed_at: NOW,
      created_at: NOW - PROMPT_UPLOAD_UNREFERENCED_TTL_MS - 1,
    };
    const { handler, repository } = buildHandler({ stale: [staleUpload] });
    const order: string[] = [];
    repository.claimStaleUnreferencedUploads.mockImplementation(() => {
      order.push("claim");
      return [staleUpload];
    });
    repository.getUploadTotals.mockImplementation(() => {
      order.push("totals");
      return { count: PROMPT_UPLOAD_LIMIT_PER_SESSION - 1, totalBytes: 0 };
    });

    const response = await handler.recordUpload(uploadRequest(VALID_BODY));

    expect(response.status).toBe(200);
    expect(order).toEqual(["claim"]);
    expect(repository.getUploadTotals).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      status: "cleanup_required",
      cleanupClaimedAt: NOW,
      staleUploads: [{ uploadId: "old-1", objectKey: "sessions/sess-1/uploads/old-1" }],
    });
  });

  it("records a valid upload", async () => {
    const { handler, repository } = buildHandler();

    const response = await handler.recordUpload(uploadRequest(VALID_BODY));

    expect(response.status).toBe(200);
    expect(repository.createUpload).toHaveBeenCalledWith({
      id: "up-1",
      mimeType: "image/png",
      sizeBytes: 1024,
      objectKey: "sessions/sess-1/uploads/up-1",
      createdAt: NOW,
    });
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("acknowledges successful cleanup and releases failed claims", async () => {
    const { handler, repository } = buildHandler();
    const response = await handler.recordUpload(
      uploadRequest({
        action: "complete_cleanup",
        cleanupClaimedAt: NOW,
        acknowledgedUploadIds: ["old-1"],
        releasedUploadIds: ["old-2"],
      })
    );

    expect(response.status).toBe(200);
    expect(repository.acknowledgeUploadCleanup).toHaveBeenCalledWith(["old-1"], NOW);
    expect(repository.releaseUploadCleanupClaims).toHaveBeenCalledWith(["old-2"], NOW);
  });
});
