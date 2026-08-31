import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExternalSessionCreateOperationStore } from "../../src/db/external-session-create-operations";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";

const USER_ID = "33333333333333333333333333333333";

describe("external session create operation transitions", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(USER_ID);
  });
  afterEach(cleanD1Tables);

  it("allows only monotonic compare-and-swap transitions", async () => {
    const store = new ExternalSessionCreateOperationStore(env.DB);
    const reserved = await store.claim({
      userId: USER_ID,
      idempotencyKey: "operation-1",
      requestHash: "hash-1",
      sessionId: "session-1",
    });
    const created = await store.markSessionCreated(reserved);
    expect(created.stage).toBe("session_created");
    const completed = await store.complete(created, { sessionId: "session-1", status: "created" });
    expect(completed).toMatchObject({
      stage: "completed",
      result: { sessionId: "session-1", status: "created" },
    });
    await expect(store.markSessionCreated(completed)).resolves.toEqual(completed);
  });

  it("returns the immutable winning result to concurrent completers", async () => {
    const store = new ExternalSessionCreateOperationStore(env.DB);
    const reserved = await store.claim({
      userId: USER_ID,
      idempotencyKey: "operation-2",
      requestHash: "hash-2",
      sessionId: "session-2",
    });
    const [createdA, createdB] = await Promise.all([
      store.markSessionCreated(reserved),
      store.markSessionCreated(reserved),
    ]);
    const [completedA, completedB] = await Promise.all([
      store.complete(createdA, { sessionId: "session-2", status: "created" }),
      store.complete(createdB, {
        sessionId: "session-2",
        messageId: "message-2",
        status: "queued",
      }),
    ]);
    expect(completedA.result).toEqual(completedB.result);
    expect(completedA.result?.sessionId).toBe("session-2");
    await expect(
      store.complete(completedA, { sessionId: "different", status: "created" })
    ).resolves.toEqual(completedA);
  });
});
