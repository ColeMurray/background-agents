import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger";
import type { ObjectStorage } from "../../storage/object-storage";
import type { SessionRuntimeClient } from "../runtime-client";
import {
  SessionAttachmentStorageService,
  type SessionAttachmentRecord,
} from "./session-attachment-storage";

const RECORD: SessionAttachmentRecord = {
  attachmentId: "up-1",
  mimeType: "image/png",
  sizeBytes: 3,
  objectKey: "sessions/session-1/attachments/up-1",
};

function buildService(responses: Array<Response | Error>) {
  const fetch = vi.fn(async (_sessionId: string, _path: unknown, _init?: RequestInit) => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Missing test response");
    return response;
  });
  const runtime: SessionRuntimeClient = { fetch };
  const storage = {
    put: vi.fn(async (_key: string) => {}),
    delete: vi.fn(async (_key: string) => {}),
    head: vi.fn(async (_key: string) => null),
    get: vi.fn(async (_key: string) => null),
  } satisfies ObjectStorage;
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  const service = new SessionAttachmentStorageService(runtime, storage, "session-1", log);
  const store = (bytes: Uint8Array) => service.store(bytes, RECORD);
  return { fetch, storage, log, store };
}

describe("SessionAttachmentStorageService", () => {
  it("registers and then stores an attachment", async () => {
    const h = buildService([Response.json({ status: "ok" })]);

    await expect(h.store(Uint8Array.from([1, 2, 3]))).resolves.toEqual({
      ok: true,
    });

    expect(h.storage.put).toHaveBeenCalledWith(RECORD.objectKey, expect.any(Uint8Array), {
      contentType: "image/png",
    });
    expect(JSON.parse(h.fetch.mock.calls[0][2]?.body as string)).toEqual({
      action: "record",
      ...RECORD,
    });
    expect(h.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      h.storage.put.mock.invocationCallOrder[0]
    );
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it("does not store an object when registration is rejected", async () => {
    const h = buildService([Response.json({ error: "Quota exceeded" }, { status: 429 })]);

    await expect(h.store(Uint8Array.from([1]))).resolves.toEqual({
      ok: false,
      status: 429,
      error: "Quota exceeded",
    });
    expect(h.storage.put).not.toHaveBeenCalled();
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it("does not store an object when registration throws", async () => {
    const h = buildService([new Error("runtime unavailable")]);

    await expect(h.store(Uint8Array.from([1]))).rejects.toThrow("runtime unavailable");
    expect(h.storage.put).not.toHaveBeenCalled();
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it("rejects without storing when the registry response is malformed", async () => {
    const h = buildService([new Response("not-json")]);

    await expect(h.store(Uint8Array.from([1]))).resolves.toEqual({
      ok: false,
      status: 502,
      error: "Attachment registry returned an invalid response",
    });
    expect(h.storage.put).not.toHaveBeenCalled();
  });

  it("leaves a discoverable attachment record when object storage fails", async () => {
    const h = buildService([Response.json({ status: "ok" })]);
    h.storage.put.mockRejectedValue(new Error("R2 unavailable"));

    await expect(h.store(Uint8Array.from([1]))).rejects.toThrow("R2 unavailable");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it("completes stale cleanup before retrying registration", async () => {
    const h = buildService([
      Response.json({
        status: "cleanup_required",
        cleanupClaimedAt: 1000,
        staleAttachments: [
          { attachmentId: "old-1", objectKey: "sessions/session-1/attachments/old-1" },
        ],
      }),
      Response.json({ status: "ok" }),
      Response.json({ status: "ok" }),
    ]);

    await expect(h.store(Uint8Array.from([1]))).resolves.toEqual({ ok: true });
    expect(h.storage.delete).toHaveBeenCalledWith("sessions/session-1/attachments/old-1");
    expect(JSON.parse(h.fetch.mock.calls[1][2]?.body as string)).toEqual({
      action: "complete_cleanup",
      cleanupClaimedAt: 1000,
      acknowledgedAttachmentIds: ["old-1"],
      releasedAttachmentIds: [],
    });
    expect(JSON.parse(h.fetch.mock.calls[2][2]?.body as string)).toEqual({
      action: "record",
      ...RECORD,
    });
    expect(h.storage.delete.mock.invocationCallOrder[0]).toBeLessThan(
      h.fetch.mock.invocationCallOrder[1]
    );
    expect(h.fetch.mock.invocationCallOrder[1]).toBeLessThan(h.fetch.mock.invocationCallOrder[2]);
  });

  it("releases failed stale deletions and rejects the new attachment", async () => {
    const h = buildService([
      Response.json({
        status: "cleanup_required",
        cleanupClaimedAt: 1000,
        staleAttachments: [
          { attachmentId: "old-1", objectKey: "sessions/session-1/attachments/old-1" },
        ],
      }),
      Response.json({ status: "ok" }),
    ]);
    h.storage.delete.mockImplementation(async (key) => {
      if (key.endsWith("/old-1")) throw new Error("R2 unavailable");
    });

    await expect(h.store(Uint8Array.from([1]))).resolves.toEqual({
      ok: false,
      status: 503,
      error: "Failed to clean up expired attachments; please retry",
    });
    expect(JSON.parse(h.fetch.mock.calls[1][2]?.body as string)).toEqual({
      action: "complete_cleanup",
      cleanupClaimedAt: 1000,
      acknowledgedAttachmentIds: [],
      releasedAttachmentIds: ["old-1"],
    });
    expect(h.storage.put).not.toHaveBeenCalled();
  });

  it("rejects without storing when cleanup completion is not acknowledged", async () => {
    const h = buildService([
      Response.json({
        status: "cleanup_required",
        cleanupClaimedAt: 1000,
        staleAttachments: [
          { attachmentId: "old-1", objectKey: "sessions/session-1/attachments/old-1" },
        ],
      }),
      Response.json({ status: "cleanup_required", cleanupClaimedAt: 1000, staleAttachments: [] }),
    ]);

    await expect(h.store(Uint8Array.from([1]))).resolves.toEqual({
      ok: false,
      status: 502,
      error: "Attachment registry returned an invalid response",
    });
    expect(h.storage.put).not.toHaveBeenCalled();
  });
});
