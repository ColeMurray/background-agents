import { env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";

/**
 * Create a fresh DO, call /internal/init, return the stub and id.
 */
export async function initSession(overrides?: {
  sessionName?: string;
  repoOwner?: string;
  repoName?: string;
  repoId?: number;
  title?: string;
  model?: string;
  userId?: string;
  githubLogin?: string;
}) {
  const id = env.SESSION.newUniqueId();
  const stub = env.SESSION.get(id);
  const defaults = {
    sessionName: `test-${Date.now()}`,
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    userId: "user-1",
    ...overrides,
  };
  const res = await stub.fetch("http://internal/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaults),
  });
  if (res.status !== 200) throw new Error(`Init failed: ${res.status}`);
  return { stub, id };
}

/**
 * Query the DO's SQLite via runInDurableObject.
 */
export async function queryDO<T>(
  stub: DurableObjectStub,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  return runInDurableObject(stub, (instance: SessionDO) => {
    return instance.ctx.storage.sql.exec(sql, ...params).toArray() as T[];
  });
}

/**
 * Seed events directly into DO SQLite.
 */
export async function seedEvents(
  stub: DurableObjectStub,
  events: Array<{
    id: string;
    type: string;
    data: string;
    messageId?: string;
    createdAt: number;
  }>
): Promise<void> {
  await runInDurableObject(stub, (instance: SessionDO) => {
    for (const e of events) {
      instance.ctx.storage.sql.exec(
        "INSERT INTO events (id, type, data, message_id, created_at) VALUES (?, ?, ?, ?, ?)",
        e.id,
        e.type,
        e.data,
        e.messageId ?? null,
        e.createdAt
      );
    }
  });
}

/**
 * Seed a message directly into DO SQLite.
 */
export async function seedMessage(
  stub: DurableObjectStub,
  msg: {
    id: string;
    authorId: string;
    content: string;
    source: string;
    status: string;
    createdAt: number;
    startedAt?: number;
  }
): Promise<void> {
  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "INSERT INTO messages (id, author_id, content, source, status, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      msg.id,
      msg.authorId,
      msg.content,
      msg.source,
      msg.status,
      msg.createdAt,
      msg.startedAt ?? null
    );
  });
}
