import { describe, expect, it, vi } from "vitest";
import {
  PROMPT_UPLOAD_LIMIT_PER_SESSION,
  PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION,
  PROMPT_UPLOAD_UNREFERENCED_TTL_MS,
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
    takeStaleUnreferencedUploads: vi.fn(() => options?.stale ?? []),
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
  uploadId: "up-1",
  kind: "image",
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
    ["invalid kind", { ...VALID_BODY, kind: "pdf" }],
    ["missing mimeType", { ...VALID_BODY, mimeType: "" }],
    ["non-positive size", { ...VALID_BODY, sizeBytes: 0 }],
    ["non-integer size", { ...VALID_BODY, sizeBytes: 1.5 }],
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
  });

  it("rejects when the upload would exceed the per-session byte cap", async () => {
    const { handler, repository } = buildHandler({
      totals: { count: 1, totalBytes: PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION - 512 },
    });

    const response = await handler.recordUpload(uploadRequest(VALID_BODY));

    expect(response.status).toBe(429);
    expect(repository.createUpload).not.toHaveBeenCalled();
  });

  it("records the upload and returns pruned stale object keys", async () => {
    const staleUpload: UploadRow = {
      id: "old-1",
      kind: "video",
      mime_type: "video/mp4",
      size_bytes: 5_000_000,
      object_key: "sessions/sess-1/uploads/old-1",
      message_id: null,
      created_at: NOW - PROMPT_UPLOAD_UNREFERENCED_TTL_MS - 1,
    };
    const { handler, repository } = buildHandler({ stale: [staleUpload] });

    const response = await handler.recordUpload(uploadRequest(VALID_BODY));

    expect(response.status).toBe(200);
    expect(repository.createUpload).toHaveBeenCalledWith({
      id: "up-1",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 1024,
      objectKey: "sessions/sess-1/uploads/up-1",
      createdAt: NOW,
    });
    expect(repository.takeStaleUnreferencedUploads).toHaveBeenCalledWith(
      NOW - PROMPT_UPLOAD_UNREFERENCED_TTL_MS
    );
    expect(await response.json()).toEqual({
      status: "ok",
      staleObjectKeys: ["sessions/sess-1/uploads/old-1"],
    });
  });
});
