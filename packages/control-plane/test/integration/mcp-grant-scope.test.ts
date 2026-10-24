import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";
import { McpConnectionStore } from "../../src/db/mcp-connections";
import { McpServerStore } from "../../src/db/mcp-servers";
import { McpSessionPinStore } from "../../src/db/mcp-session-pins";
import {
  evaluateMcpGrantScope,
  evaluateMcpGrantTool,
  reviewedReadOnlyToolNames,
} from "../../src/session/mcp-grant-scope";

/**
 * A grant is a decision made at one moment. The authority behind it can
 * change after that moment, and a change is an operator's revocation signal.
 *
 * These are the three ways that happens, and each one must stop the grant.
 */
describe("MCP grant scope, re-evaluated against current authority", () => {
  const OWNER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SESSION_ID = "mcp-grant-scope-session";
  const REPOSITORIES = [{ repoOwner: "acme", repoName: "allowed" }];
  const db = sqlDatabase(env.DB);

  beforeEach(cleanD1Tables);

  async function createServerWithScope(scope: string[]): Promise<{
    id: string;
    revision: number;
  }> {
    const response = await serviceFetch("https://test.local/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "scoped-server",
        type: "remote",
        url: "https://mcp.example.com/mcp",
      }),
    });
    expect(response.status).toBe(201);
    const server = (await response.json()) as { id: string; revision: number };
    await db
      .prepare("UPDATE mcp_servers SET repo_scope = ? WHERE id = ?")
      .bind(JSON.stringify(scope), server.id)
      .run();
    return server;
  }

  async function reviewTool(serverId: string, serverRevision: number, toolName: string) {
    await db
      .prepare(
        `INSERT INTO mcp_reviewed_tools
           (stable_tool_id, server_id, server_revision, tool_name, title, description,
            input_schema_json, input_schema_sha256, output_schema_json, output_schema_sha256,
            effect, reviewed_by_user_id, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'external_read', ?, ?)`
      )
      .bind(
        `stable_${toolName}_${serverRevision}`,
        serverId,
        serverRevision,
        toolName,
        toolName,
        toolName,
        JSON.stringify({ type: "object" }),
        "0".repeat(64),
        OWNER,
        Date.now()
      )
      .run();
  }

  async function grant(server: { id: string; revision: number }) {
    const created = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
      as: { userId: OWNER, role: "member" },
    });
    expect(created.status).toBe(201);
    const connection = (await created.json()) as {
      id: string;
      catalogSnapshotSha256: string;
    };
    await reviewTool(server.id, server.revision, "read_page");
    const pin = await new McpSessionPinStore(db).grant({
      ownerUserId: OWNER,
      connectionId: connection.id,
      sessionId: SESSION_ID,
      catalogSnapshotSha256: connection.catalogSnapshotSha256,
      toolNames: ["read_page"],
    });
    return { connectionId: connection.id, pin };
  }

  function scopeOptions() {
    return {
      db: db,
      servers: new McpServerStore(db, ""),
      connections: new McpConnectionStore(db),
      reviewedToolNames: (serverId: string, serverRevision: number) =>
        reviewedReadOnlyToolNames(db, serverId, serverRevision),
    };
  }

  it("allows a grant whose server still covers the session's repositories", async () => {
    const server = await createServerWithScope(["acme/allowed"]);
    const { connectionId } = await grant(server);

    const decision = await evaluateMcpGrantScope(scopeOptions(), {
      connectionId,
      ownerUserId: OWNER,
      repositories: REPOSITORIES,
    });

    expect(decision.kind).toBe("allowed");
  });

  it("refuses a grant whose server scope was narrowed after the grant", async () => {
    const server = await createServerWithScope(["acme/allowed"]);
    const { connectionId, pin } = await grant(server);
    expect(pin.toolNames).toEqual(["read_page"]);

    // The operator narrows the server's scope. The pin still names the tool.
    await db
      .prepare("UPDATE mcp_servers SET repo_scope = ? WHERE id = ?")
      .bind(JSON.stringify(["acme/somewhere-else"]), server.id)
      .run();

    const decision = await evaluateMcpGrantScope(scopeOptions(), {
      connectionId,
      ownerUserId: OWNER,
      repositories: REPOSITORIES,
    });

    expect(decision.kind).toBe("denied");
    if (decision.kind === "denied") {
      expect(decision.reason).toBe("This MCP server is not available to this session");
    }
  });

  it("refuses a grant whose server was disabled after the grant", async () => {
    const server = await createServerWithScope([]);
    const { connectionId } = await grant(server);

    await db.prepare("UPDATE mcp_servers SET enabled = 0 WHERE id = ?").bind(server.id).run();

    const decision = await evaluateMcpGrantScope(scopeOptions(), {
      connectionId,
      ownerUserId: OWNER,
      repositories: REPOSITORIES,
    });

    expect(decision.kind).toBe("denied");
  });

  it("refuses a tool the server's current review no longer carries", async () => {
    const server = await createServerWithScope([]);
    const { connectionId, pin } = await grant(server);

    await db
      .prepare(
        "DELETE FROM mcp_reviewed_tools WHERE server_id = ? AND server_revision = ? AND tool_name = ?"
      )
      .bind(server.id, server.revision, "read_page")
      .run();

    const decision = await evaluateMcpGrantTool(scopeOptions(), {
      connectionId,
      ownerUserId: OWNER,
      repositories: REPOSITORIES,
      toolName: "read_page",
      pinnedToolNames: pin.toolNames,
    });

    expect(decision.kind).toBe("denied");
    if (decision.kind === "denied") {
      expect(decision.reason).toBe("This MCP tool is not part of the reviewed catalog");
    }
  });

  it("revokes the connection when the server review revision changes", async () => {
    const server = await createServerWithScope([]);
    const { connectionId, pin } = await grant(server);

    // The scope still allows it; the *review* moved on and the tool is gone.
    await db
      .prepare("UPDATE mcp_servers SET revision = revision + 1 WHERE id = ?")
      .bind(server.id)
      .run();

    const scope = await evaluateMcpGrantScope(scopeOptions(), {
      connectionId,
      ownerUserId: OWNER,
      repositories: REPOSITORIES,
    });
    expect(pin.toolNames).toEqual(["read_page"]);
    expect(scope.kind).toBe("denied");
    if (scope.kind === "denied") {
      expect(scope.reason).toBe("This MCP connection no longer matches its reviewed server");
    }
  });

  it("refuses a tool the pin never froze, even when the review carries it", async () => {
    const server = await createServerWithScope([]);
    const { connectionId } = await grant(server);

    const decision = await evaluateMcpGrantTool(scopeOptions(), {
      connectionId,
      ownerUserId: OWNER,
      repositories: REPOSITORIES,
      toolName: "another_tool",
      pinnedToolNames: ["read_page"],
    });

    expect(decision.kind).toBe("denied");
    if (decision.kind === "denied") {
      expect(decision.reason).toBe("This MCP tool is not part of the granted catalog");
    }
  });
});
