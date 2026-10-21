/**
 * Unit tests for McpServerReviewStore.
 *
 * The store is the shared lane's executable catalog: the review says which
 * tools exist, what they take, and that they are reads. A tool that is not
 * reviewed is not callable, and a tool the reviewer classified as a mutation
 * never is.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildMcpToolReview,
  McpReviewValidationError,
  McpServerReviewStore,
} from "./mcp-server-reviews";

interface FakeStatement {
  sql: string;
  params: unknown[];
}

function createFakeD1(options?: {
  serverRevision?: number | null;
  rows?: Array<Record<string, unknown>>;
  readOnlyRows?: Array<{ tool_name: string }>;
}) {
  const statements: FakeStatement[] = [];
  const serverRevision = options?.serverRevision === undefined ? 3 : options.serverRevision;

  const fakeStmt = {
    bind(...params: unknown[]) {
      statements[statements.length - 1]!.params = params;
      return fakeStmt;
    },
    async first<T>(): Promise<T | null> {
      if (serverRevision === null) return null;
      return { revision: serverRevision } as T;
    },
    async all<T>(): Promise<D1Result<T>> {
      const sql = statements[statements.length - 1]!.sql;
      const results = sql.includes("effect = 'external_read'")
        ? (options?.readOnlyRows ?? [])
        : (options?.rows ?? []);
      return {
        results: results as T[],
        success: true,
        meta: { duration: 0, changes: 0 },
      } as unknown as D1Result<T>;
    },
    async run(): Promise<D1Result> {
      return {
        results: [],
        success: true,
        meta: { duration: 0, changes: 1 },
      } as unknown as D1Result;
    },
  };

  const db = {
    prepare(sql: string) {
      statements.push({ sql, params: [] });
      return fakeStmt;
    },
    batch: vi.fn(async (batch: unknown[]) => batch.map(() => ({ success: true }))),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return { db, statements };
}

const TOOL_ROW = {
  stable_tool_id: "mcptool_1",
  server_id: "mcpsrv_1",
  server_revision: 3,
  tool_name: "search",
  title: null,
  description: null,
  input_schema_json: '{"type":"object"}',
  input_schema_sha256: "a".repeat(64),
  output_schema_json: null,
  output_schema_sha256: null,
  effect: "external_read" as const,
  reviewed_by_user_id: "user-1",
  reviewed_at: 1_700_000_000_000,
};

describe("McpServerReviewStore", () => {
  it("refuses a review of a server that does not exist", async () => {
    const { db } = createFakeD1({ serverRevision: null });
    const store = new McpServerReviewStore(db as never);

    await expect(
      store.review({
        reviewedByUserId: "user-1",
        serverId: "mcpsrv_1",
        serverRevision: 3,
        tools: [],
      })
    ).rejects.toBeInstanceOf(McpReviewValidationError);
  });

  it("refuses a review of a revision the server has moved past", async () => {
    const { db } = createFakeD1({ serverRevision: 4 });
    const store = new McpServerReviewStore(db as never);

    await expect(
      store.review({
        reviewedByUserId: "user-1",
        serverId: "mcpsrv_1",
        serverRevision: 3,
        tools: [],
      })
    ).rejects.toThrow("The MCP server changed; review the current catalog again");
  });

  it("replaces the whole revision, so a withdrawn tool cannot survive", async () => {
    const { db, statements } = createFakeD1({ serverRevision: 3 });
    const store = new McpServerReviewStore(db as never);
    const tool = await buildMcpToolReview({
      toolName: "search",
      inputSchema: { type: "object" },
      effect: "external_read",
    });

    const review = await store.review({
      reviewedByUserId: "user-1",
      serverId: "mcpsrv_1",
      serverRevision: 3,
      tools: [tool],
    });

    expect(review.tools.map((entry) => entry.toolName)).toEqual(["search"]);
    const sql = statements.map((statement) => statement.sql).join("\n");
    expect(sql).toContain(
      "DELETE FROM mcp_reviewed_tools WHERE server_id = ? AND server_revision = ?"
    );
    expect(sql).toContain("INSERT INTO mcp_reviewed_tools");
  });

  it("reads the review of one revision back", async () => {
    const { db } = createFakeD1({ serverRevision: 3, rows: [TOOL_ROW] });
    const store = new McpServerReviewStore(db as never);

    const review = await store.get("mcpsrv_1", 3);

    expect(review).toMatchObject({
      serverId: "mcpsrv_1",
      serverRevision: 3,
      reviewedByUserId: "user-1",
    });
    expect(review?.tools[0]).toMatchObject({
      stableToolId: "mcptool_1",
      toolName: "search",
      effect: "external_read",
      inputSchema: { type: "object" },
    });
  });

  it("has no review for a revision that was never reviewed", async () => {
    const { db } = createFakeD1({ serverRevision: 3, rows: [] });
    const store = new McpServerReviewStore(db as never);

    await expect(store.get("mcpsrv_1", 3)).resolves.toBeNull();
  });

  it("lists only the read-only tools the current review carries", async () => {
    const { db, statements } = createFakeD1({
      serverRevision: 3,
      readOnlyRows: [{ tool_name: "search" }],
    });
    const store = new McpServerReviewStore(db as never);

    await expect(store.reviewedReadOnlyToolNames("mcpsrv_1", 3)).resolves.toEqual(["search"]);
    expect(statements[statements.length - 1]!.sql).toContain("effect = 'external_read'");
  });

  it("builds a stable tool identity and schema hashes", async () => {
    const first = await buildMcpToolReview({
      toolName: "search",
      inputSchema: { type: "object" },
      effect: "external_read",
    });
    const second = await buildMcpToolReview({
      toolName: "search",
      inputSchema: { type: "object" },
      effect: "external_read",
    });

    expect(first.stableToolId).toBe(second.stableToolId);
    expect(first.inputSchemaSha256).toBe(second.inputSchemaSha256);
    expect(first.inputSchemaSha256).toHaveLength(64);
  });
});
