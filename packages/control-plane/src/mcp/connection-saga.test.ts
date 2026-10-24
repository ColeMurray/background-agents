import { describe, expect, it } from "vitest";
import type { McpConnectionMetadata } from "@open-inspect/shared/types/integrations";
import { McpConnectionSaga, type McpConnectionSagaAuthority } from "./connection-saga";

const OWNER = "11111111111111111111111111111111";
const SERVER = "server-1";

function connection(
  id: string,
  status: McpConnectionMetadata["status"] = "foundation_staged"
): McpConnectionMetadata {
  return {
    id,
    serverId: SERVER,
    serverRevision: 1,
    serverName: "Remote",
    endpointUrl: "https://mcp.example.com/mcp",
    endpointHost: "mcp.example.com",
    catalogSnapshotSha256: "a".repeat(64),
    status,
    tools: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function harness(initial?: McpConnectionMetadata) {
  const events: string[] = [];
  let row = initial;
  let next = 1;
  let initializeFailure: Error | undefined;
  let destroyFailure: Error | undefined;
  let destroyFailureAfterCleanup: Error | undefined;
  let deleteFailure: Error | undefined;
  let brokerDestroyed = false;
  const authority: McpConnectionSagaAuthority = {
    async findOwnedByServer() {
      return row ?? null;
    },
    async getOwnedForSaga(id, ownerUserId) {
      return row?.id === id && ownerUserId === OWNER ? row : null;
    },
    async create() {
      events.push("d1:create");
      row = connection(`mcpconn_${String(next++).padStart(32, "0")}`);
      return row;
    },
    async markRevoking(id) {
      events.push("d1:mark-revoking");
      if (!row || row.id !== id) return null;
      row = { ...row, status: "revoking" };
      return row;
    },
    async deleteRevoking(id) {
      events.push("d1:delete-revoking");
      if (deleteFailure) throw deleteFailure;
      if (!row || row.id !== id || row.status !== "revoking") return false;
      row = undefined;
      return true;
    },
  };
  const broker = {
    async initialize() {
      events.push("do:initialize");
      if (initializeFailure) throw initializeFailure;
    },
    async destroy() {
      events.push("do:destroy");
      if (destroyFailure) throw destroyFailure;
      brokerDestroyed = true;
      if (destroyFailureAfterCleanup) throw destroyFailureAfterCleanup;
    },
    async authorize(connectionId: string, ownerUserId: string, options?: { reconnect?: boolean }) {
      events.push(`do:authorize:${connectionId}:${ownerUserId}:${options?.reconnect === true}`);
      return { state: "authenticating" as const, authUrl: "https://auth.example.com/authorize" };
    },
  };
  return {
    saga: new McpConnectionSaga(authority, broker),
    events,
    row: () => row,
    failInitialize(error?: Error) {
      initializeFailure = error;
    },
    failDestroy(error?: Error) {
      destroyFailure = error;
    },
    failDestroyAfterCleanup(error?: Error) {
      destroyFailureAfterCleanup = error;
    },
    failDelete(error?: Error) {
      deleteFailure = error;
    },
    brokerDestroyed: () => brokerDestroyed,
  };
}

describe("MCP connection saga", () => {
  it("authorizes only a connection the owner owns, and passes the owner's own reconnect choice", async () => {
    const test = harness(connection("mcpconn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));

    await expect(test.saga.authorize(OWNER, test.row()!.id)).resolves.toEqual({
      state: "authenticating",
      authUrl: "https://auth.example.com/authorize",
    });
    expect(test.events).toEqual([`do:authorize:${test.row()!.id}:${OWNER}:false`]);

    await expect(test.saga.authorize("someone-else", test.row()!.id)).resolves.toBeNull();
    await expect(test.saga.authorize(OWNER, "mcpconn_unknown")).resolves.toBeNull();
  });

  it("checkpoints revocation before closing transport, clearing OAuth, tombstoning, and deleting D1", async () => {
    const test = harness(connection("mcpconn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));

    await expect(test.saga.revoke(OWNER, test.row()!.id)).resolves.toBe("deleted");

    expect(test.events).toEqual(["d1:mark-revoking", "do:destroy", "d1:delete-revoking"]);
    expect(test.row()).toBeUndefined();
  });

  it("leaves revoking durable when broker teardown fails and resumes on retry", async () => {
    const test = harness(connection("mcpconn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    test.failDestroy(new Error("broker unavailable"));

    await expect(test.saga.revoke(OWNER, test.row()!.id)).rejects.toThrow("broker unavailable");
    expect(test.row()?.status).toBe("revoking");

    test.failDestroy();
    await expect(test.saga.revoke(OWNER, test.row()!.id)).resolves.toBe("deleted");
    expect(test.events).toEqual([
      "d1:mark-revoking",
      "do:destroy",
      "do:destroy",
      "d1:delete-revoking",
    ]);
  });

  it("converges when broker cleanup succeeds but its response is lost", async () => {
    const test = harness(connection("mcpconn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    test.failDestroyAfterCleanup(new Error("destroy response lost"));

    await expect(test.saga.revoke(OWNER, test.row()!.id)).rejects.toThrow("destroy response lost");
    expect(test.brokerDestroyed()).toBe(true);
    expect(test.row()?.status).toBe("revoking");

    test.failDestroyAfterCleanup();
    await expect(test.saga.revoke(OWNER, test.row()!.id)).resolves.toBe("deleted");
    expect(test.events).toEqual([
      "d1:mark-revoking",
      "do:destroy",
      "do:destroy",
      "d1:delete-revoking",
    ]);
  });

  it("converges when broker cleanup succeeds but D1 metadata deletion fails", async () => {
    const test = harness(connection("mcpconn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    test.failDelete(new Error("D1 unavailable"));

    await expect(test.saga.revoke(OWNER, test.row()!.id)).rejects.toThrow("D1 unavailable");
    expect(test.brokerDestroyed()).toBe(true);
    expect(test.row()?.status).toBe("revoking");

    test.failDelete();
    await expect(test.saga.revoke(OWNER, test.row()!.id)).resolves.toBe("deleted");
    expect(test.events).toEqual([
      "d1:mark-revoking",
      "do:destroy",
      "d1:delete-revoking",
      "do:destroy",
      "d1:delete-revoking",
    ]);
  });

  it("compensates a possibly initialized broker before deleting failed creation metadata", async () => {
    const test = harness();
    test.failInitialize(new Error("initialize response lost"));

    await expect(test.saga.create(OWNER, SERVER)).rejects.toThrow("initialize response lost");

    expect(test.events).toEqual([
      "d1:create",
      "do:initialize",
      "d1:mark-revoking",
      "do:destroy",
      "d1:delete-revoking",
    ]);
    expect(test.row()).toBeUndefined();
  });

  it("resumes incomplete creation compensation before creating a replacement", async () => {
    const stale = connection("mcpconn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "revoking");
    const test = harness(stale);
    test.failDestroy(new Error("still unavailable"));

    await expect(test.saga.create(OWNER, SERVER)).rejects.toThrow("still unavailable");
    expect(test.row()).toEqual(stale);

    test.failDestroy();
    await expect(test.saga.create(OWNER, SERVER)).resolves.toMatchObject({
      id: "mcpconn_00000000000000000000000000000001",
      status: "foundation_staged",
    });
    expect(test.events).toEqual([
      "do:destroy",
      "do:destroy",
      "d1:delete-revoking",
      "d1:create",
      "do:initialize",
    ]);
  });

  it("resumes creation compensation when broker cleanup completed but its response was lost", async () => {
    const test = harness();
    test.failInitialize(new Error("initialize failed"));
    test.failDestroyAfterCleanup(new Error("destroy response lost"));

    await expect(test.saga.create(OWNER, SERVER)).rejects.toThrow(/compensation remains pending/i);
    expect(test.brokerDestroyed()).toBe(true);
    expect(test.row()?.status).toBe("revoking");

    test.failInitialize();
    test.failDestroyAfterCleanup();
    await expect(test.saga.create(OWNER, SERVER)).resolves.toMatchObject({
      id: "mcpconn_00000000000000000000000000000002",
      status: "foundation_staged",
    });
  });

  it("reuses an existing staged row and makes broker initialization idempotent", async () => {
    const existing = connection("mcpconn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const test = harness(existing);

    await expect(test.saga.create(OWNER, SERVER)).resolves.toEqual(existing);
    expect(test.events).toEqual(["do:initialize"]);
  });

  it("treats an already deleted connection as a successful retry", async () => {
    const test = harness();
    await expect(test.saga.revoke(OWNER, "mcpconn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBe(
      "already_deleted"
    );
    expect(test.events).toEqual([]);
  });
});
