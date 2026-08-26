import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { SessionRouteContext } from "./session-route";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import {
  getSessionArtifactFromRuntime,
  listSessionArtifactsFromRuntime,
  persistMediaArtifact,
} from "./session-media-artifacts";

function createContext(response: Response): SessionRouteContext {
  const sessionRuntime: SessionRuntimeClient = {
    fetch: vi.fn(async () => response),
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
