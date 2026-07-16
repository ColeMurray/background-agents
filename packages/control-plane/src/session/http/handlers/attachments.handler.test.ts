import { describe, expect, it, vi } from "vitest";
import {
  SESSION_ATTACHMENT_LIMIT_PER_SESSION,
  SESSION_ATTACHMENT_IMAGE_MAX_BYTES,
  SESSION_ATTACHMENT_TOTAL_BYTES_PER_SESSION,
  SESSION_ATTACHMENT_UNREFERENCED_TTL_MS,
  SESSION_ATTACHMENT_CLEANUP_CLAIM_TTL_MS,
} from "../../../media";
import type { SessionAttachmentRow } from "../../types";
import { AttachmentsHandler } from "./attachments.handler";

const NOW = 1_000_000_000;

function buildHandler(options?: {
  sessionExists?: boolean;
  totals?: { count: number; totalBytes: number };
  stale?: SessionAttachmentRow[];
}) {
  const repository = {
    create: vi.fn(),
    getTotals: vi.fn(() => options?.totals ?? { count: 0, totalBytes: 0 }),
    claimStale: vi.fn(() => options?.stale ?? []),
    acknowledgeCleanup: vi.fn(),
    releaseCleanupClaims: vi.fn(),
  };

  const sessionExists = options?.sessionExists ?? true;
  const handler = new AttachmentsHandler(
    repository as never,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    () => NOW
  );

  return { handler, repository, sessionExists };
}

function uploadRequest(body: unknown): Request {
  return new Request("http://internal/internal/attachments", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  action: "record",
  attachmentId: "up-1",
  mimeType: "image/png",
  sizeBytes: 1024,
  objectKey: "sessions/sess-1/attachments/up-1",
};

describe("AttachmentsHandler", () => {
  it("returns 404 when the session is not initialized", async () => {
    const { handler, repository, sessionExists } = buildHandler({ sessionExists: false });

    const response = await handler.recordAttachment(uploadRequest(VALID_BODY), sessionExists);

    expect(response.status).toBe(404);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing attachmentId", { ...VALID_BODY, attachmentId: "" }],
    ["invalid action", { ...VALID_BODY, action: "invalid" }],
    ["unsupported MIME type", { ...VALID_BODY, mimeType: "video/mp4" }],
    ["missing mimeType", { ...VALID_BODY, mimeType: "" }],
    ["non-positive size", { ...VALID_BODY, sizeBytes: 0 }],
    ["non-integer size", { ...VALID_BODY, sizeBytes: 1.5 }],
    ["oversized upload", { ...VALID_BODY, sizeBytes: SESSION_ATTACHMENT_IMAGE_MAX_BYTES + 1 }],
    ["missing objectKey", { ...VALID_BODY, objectKey: "" }],
  ])("rejects %s with 400", async (_label, body) => {
    const { handler, repository, sessionExists } = buildHandler();

    const response = await handler.recordAttachment(uploadRequest(body), sessionExists);

    expect(response.status).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("rejects when the per-session file count cap is reached", async () => {
    const { handler, repository, sessionExists } = buildHandler({
      totals: { count: SESSION_ATTACHMENT_LIMIT_PER_SESSION, totalBytes: 0 },
    });

    const response = await handler.recordAttachment(uploadRequest(VALID_BODY), sessionExists);

    expect(response.status).toBe(429);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.claimStale).toHaveBeenCalledWith(
      NOW - SESSION_ATTACHMENT_UNREFERENCED_TTL_MS,
      NOW,
      NOW - SESSION_ATTACHMENT_CLEANUP_CLAIM_TTL_MS
    );
  });

  it("rejects when the upload would exceed the per-session byte cap", async () => {
    const { handler, repository, sessionExists } = buildHandler({
      totals: { count: 1, totalBytes: SESSION_ATTACHMENT_TOTAL_BYTES_PER_SESSION - 512 },
    });

    const response = await handler.recordAttachment(uploadRequest(VALID_BODY), sessionExists);

    expect(response.status).toBe(429);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("prunes stale attachments before enforcing quota totals", async () => {
    const staleAttachment: SessionAttachmentRow = {
      id: "old-1",
      mime_type: "image/png",
      size_bytes: 1024,
      object_key: "sessions/sess-1/attachments/old-1",
      message_id: null,
      cleanup_claimed_at: NOW,
      created_at: NOW - SESSION_ATTACHMENT_UNREFERENCED_TTL_MS - 1,
    };
    const { handler, repository, sessionExists } = buildHandler({ stale: [staleAttachment] });
    const order: string[] = [];
    repository.claimStale.mockImplementation(() => {
      order.push("claim");
      return [staleAttachment];
    });
    repository.getTotals.mockImplementation(() => {
      order.push("totals");
      return { count: SESSION_ATTACHMENT_LIMIT_PER_SESSION - 1, totalBytes: 0 };
    });

    const response = await handler.recordAttachment(uploadRequest(VALID_BODY), sessionExists);

    expect(response.status).toBe(200);
    expect(order).toEqual(["claim"]);
    expect(repository.getTotals).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      status: "cleanup_required",
      cleanupClaimedAt: NOW,
      staleAttachments: [{ attachmentId: "old-1", objectKey: "sessions/sess-1/attachments/old-1" }],
    });
  });

  it("records a valid upload", async () => {
    const { handler, repository, sessionExists } = buildHandler();

    const response = await handler.recordAttachment(uploadRequest(VALID_BODY), sessionExists);

    expect(response.status).toBe(200);
    expect(repository.create).toHaveBeenCalledWith({
      id: "up-1",
      mimeType: "image/png",
      sizeBytes: 1024,
      objectKey: "sessions/sess-1/attachments/up-1",
      createdAt: NOW,
    });
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("acknowledges successful cleanup and releases failed claims", async () => {
    const { handler, repository, sessionExists } = buildHandler();
    const response = await handler.recordAttachment(
      uploadRequest({
        action: "complete_cleanup",
        cleanupClaimedAt: NOW,
        acknowledgedAttachmentIds: ["old-1"],
        releasedAttachmentIds: ["old-2"],
      }),
      sessionExists
    );

    expect(response.status).toBe(200);
    expect(repository.acknowledgeCleanup).toHaveBeenCalledWith(["old-1"], NOW);
    expect(repository.releaseCleanupClaims).toHaveBeenCalledWith(["old-2"], NOW);
  });
});
