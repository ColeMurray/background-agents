import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { CrossSessionReceiptStore, type CrossSessionReceiptRecord } from "./cross-session-receipts";

let db: NodeSqlDatabase;

beforeEach(() => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE cross_session_receipts (
    id TEXT PRIMARY KEY,
    source_session_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    human_actor_id TEXT NOT NULL,
    agent_conversation_id TEXT,
    source_task_id TEXT,
    depth INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    target_message_id TEXT,
    rejection_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source_session_id, idempotency_key)
  )`);
  db = createNodeSqlDatabase(sqlite);
});

function receipt(index: number): CrossSessionReceiptRecord {
  return {
    id: `xsr_${index}`,
    sourceSessionId: "session-1",
    targetSessionId: `session-${index + 2}`,
    operationId: "message-1",
    humanActorId: "user-1",
    agentConversationId: null,
    sourceTaskId: null,
    depth: 0,
    idempotencyKey: `call-${index}`,
    contentSha256: String(index).padStart(64, "0"),
    status: "pending",
    targetMessageId: null,
    rejectionReason: null,
    createdAt: index,
    updatedAt: index,
  };
}

describe("CrossSessionReceiptStore", () => {
  it("claims no more than the operation fan-out cap", async () => {
    const store = new CrossSessionReceiptStore(db);

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) => store.createWithinFanOutLimit(receipt(index), 5))
    );

    expect(claims.filter(Boolean)).toHaveLength(5);
    await expect(store.countForOperation("session-1", "message-1")).resolves.toBe(5);
  });
});
