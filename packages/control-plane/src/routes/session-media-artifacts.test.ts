import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { ObjectStorage } from "../storage/object-storage";
import type { SessionRouteContext } from "./session-route";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import {
  getSessionArtifactFromRuntime,
  listSessionArtifactsFromRuntime,
  persistMediaArtifact,
} from "./session-media-artifacts";

function createContext(result: Response | Error): SessionRouteContext {
  const sessionRuntime: SessionRuntimeClient = {
    fetch: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };

  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
    sessionRuntime,
  };
}

function createStorage(deleteImpl = vi.fn(async () => undefined)): ObjectStorage {
  return {
    put: vi.fn(async () => undefined),
    delete: deleteImpl,
    head: vi.fn(async () => null),
    get: vi.fn(async () => null),
  };
}

function persistInput(
  ctx: SessionRouteContext,
  storage: ObjectStorage
): Parameters<typeof persistMediaArtifact>[0] {
  const objectKey = "sessions/session-1/artifact-1.png";
  return {
    sessionId: "session-1",
    artifactId: "artifact-1",
    artifactType: "screenshot" as const,
    objectKey,
    metadata: {
      objectKey,
      mimeType: "image/png",
      sizeBytes: 123,
    },
    storage,
    ctx,
    parseFallback: "Invalid artifact metadata",
  };
}

describe("persistMediaArtifact", () => {
  it("returns null and keeps storage when the runtime persists the artifact", async () => {
    const ctx = createContext(Response.json({ ok: true }));
    const storage = createStorage();

    const result = await persistMediaArtifact(persistInput(ctx, storage));

    expect(result).toBeNull();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(ctx.sessionRuntime.fetch).toHaveBeenCalledWith(
      "session-1",
      SessionInternalPaths.createMediaArtifact,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId: "artifact-1",
          artifactType: "screenshot",
          objectKey: "sessions/session-1/artifact-1.png",
          metadata: {
            objectKey: "sessions/session-1/artifact-1.png",
            mimeType: "image/png",
            sizeBytes: 123,
          },
        }),
      })
    );
  });

  it("deletes uploaded storage and returns runtime validation errors", async () => {
    const ctx = createContext(Response.json({ error: "bad metadata" }, { status: 400 }));
    const storage = createStorage();

    const result = await persistMediaArtifact(persistInput(ctx, storage));

    expect(storage.delete).toHaveBeenCalledWith("sessions/session-1/artifact-1.png");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    await expect((result as Response).json()).resolves.toEqual({ error: "bad metadata" });
  });

  it("deletes uploaded storage when the runtime request rejects", async () => {
    const runtimeError = new Error("runtime unavailable");
    const ctx = createContext(runtimeError);
    const storage = createStorage();

    await expect(persistMediaArtifact(persistInput(ctx, storage))).rejects.toBe(runtimeError);

    expect(storage.delete).toHaveBeenCalledWith("sessions/session-1/artifact-1.png");
  });

  it("deletes uploaded storage and hides runtime 5xx details", async () => {
    const ctx = createContext(Response.json({ error: "database unavailable" }, { status: 503 }));
    const storage = createStorage();

    const result = await persistMediaArtifact(persistInput(ctx, storage));

    expect(storage.delete).toHaveBeenCalledWith("sessions/session-1/artifact-1.png");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    await expect((result as Response).json()).resolves.toEqual({
      error: "Failed to persist media artifact",
    });
  });

  it("uses the raw runtime body for non-JSON 4xx errors", async () => {
    const ctx = createContext(new Response("invalid multipart payload", { status: 422 }));
    const storage = createStorage();

    const result = await persistMediaArtifact(persistInput(ctx, storage));

    expect(storage.delete).toHaveBeenCalledWith("sessions/session-1/artifact-1.png");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(422);
    await expect((result as Response).json()).resolves.toEqual({
      error: "invalid multipart payload",
    });
  });

  it("still returns the runtime error when cleanup deletion fails", async () => {
    const ctx = createContext(Response.json({ error: "bad metadata" }, { status: 400 }));
    const storage = createStorage(vi.fn(async () => Promise.reject(new Error("r2 unavailable"))));

    const result = await persistMediaArtifact(persistInput(ctx, storage));

    expect(storage.delete).toHaveBeenCalledWith("sessions/session-1/artifact-1.png");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    await expect((result as Response).json()).resolves.toEqual({ error: "bad metadata" });
  });
});

describe("session media artifact runtime parsing", () => {
  it("parses a valid artifact list response", async () => {
    const ctx = createContext(
      Response.json({
        artifacts: [
          {
            id: "artifact-1",
            type: "screenshot",
            url: "https://example.com/shot.png",
            metadata: null,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_001,
          },
        ],
      })
    );

    const result = await listSessionArtifactsFromRuntime("session-1", ctx);

    expect(result).toEqual([
      {
        id: "artifact-1",
        type: "screenshot",
        url: "https://example.com/shot.png",
        metadata: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
      },
    ]);
  });

  it("rejects a malformed artifact list response", async () => {
    const ctx = createContext(
      Response.json({
        artifacts: [{ id: "artifact-1", type: "screenshot" }],
      })
    );

    const result = await listSessionArtifactsFromRuntime("session-1", ctx);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    await expect((result as Response).json()).resolves.toEqual({
      error: "Failed to list session artifacts",
    });
  });

  it("rejects a non-JSON 2xx artifact list response", async () => {
    const ctx = createContext(new Response("not json", { status: 200 }));

    const result = await listSessionArtifactsFromRuntime("session-1", ctx);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    await expect((result as Response).json()).resolves.toEqual({
      error: "Failed to list session artifacts",
    });
  });

  it("rejects an empty-body 2xx artifact list response", async () => {
    const ctx = createContext(new Response(null, { status: 200 }));

    const result = await listSessionArtifactsFromRuntime("session-1", ctx);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
  });

  it("falls back to createdAt when the runtime omits updatedAt", async () => {
    const ctx = createContext(
      Response.json({
        artifacts: [
          {
            id: "artifact-1",
            type: "screenshot",
            url: null,
            metadata: null,
            createdAt: 1_700_000_000_000,
          },
        ],
      })
    );

    const result = await listSessionArtifactsFromRuntime("session-1", ctx);

    expect(result).toEqual([
      {
        id: "artifact-1",
        type: "screenshot",
        url: null,
        metadata: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ]);
  });

  it("parses a nullable artifact response", async () => {
    const ctx = createContext(Response.json({ artifact: null }));

    const result = await getSessionArtifactFromRuntime("session-1", "artifact-1", ctx);

    expect(result).toBeNull();
  });

  it("rejects a non-JSON 2xx artifact fetch response", async () => {
    const ctx = createContext(new Response("not json", { status: 200 }));

    const result = await getSessionArtifactFromRuntime("session-1", "artifact-1", ctx);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    await expect((result as Response).json()).resolves.toEqual({
      error: "Failed to fetch session artifact",
    });
  });

  it("rejects a malformed artifact fetch response", async () => {
    const ctx = createContext(Response.json({ artifact: { id: "artifact-1" } }));

    const result = await getSessionArtifactFromRuntime("session-1", "artifact-1", ctx);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
  });

  it("uses a valid runtime error message when media persistence fails", async () => {
    const deleteObject = vi.fn(async () => {});
    const result = await persistMediaArtifact({
      sessionId: "session-1",
      artifactId: "artifact-1",
      artifactType: "screenshot",
      objectKey: "objects/shot.png",
      metadata: { objectKey: "objects/shot.png", mimeType: "image/png", sizeBytes: 123 },
      storage: { put: vi.fn(), get: vi.fn(), head: vi.fn(), delete: deleteObject },
      ctx: createContext(Response.json({ error: "runtime failed" }, { status: 400 })),
      parseFallback: "Failed to parse screenshot metadata",
    });

    expect(deleteObject).toHaveBeenCalledWith("objects/shot.png");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    await expect((result as Response).json()).resolves.toEqual({ error: "runtime failed" });
  });

  it("falls back to raw runtime text when media persistence error JSON is malformed", async () => {
    const result = await persistMediaArtifact({
      sessionId: "session-1",
      artifactId: "artifact-1",
      artifactType: "screenshot",
      objectKey: "objects/shot.png",
      metadata: { objectKey: "objects/shot.png", mimeType: "image/png", sizeBytes: 123 },
      storage: { put: vi.fn(), get: vi.fn(), head: vi.fn(), delete: vi.fn(async () => {}) },
      ctx: createContext(Response.json({ error: 123 }, { status: 400 })),
      parseFallback: "Failed to parse screenshot metadata",
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    await expect((result as Response).json()).resolves.toEqual({ error: '{"error":123}' });
  });
});
