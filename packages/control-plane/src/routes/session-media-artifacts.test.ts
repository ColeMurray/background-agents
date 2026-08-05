import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { SessionRouteContext } from "./session-route";
import {
  getSessionArtifactFromRuntime,
  listSessionArtifactsFromRuntime,
} from "./session-media-artifacts";

function createContext(response: Response): SessionRouteContext {
  const sessionRuntime: SessionRuntimeClient = {
    fetch: vi.fn(async () => response),
  };

  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as SqlDatabase,
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
});
