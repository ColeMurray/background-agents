import { beforeEach, expect, it } from "vitest";
import { EventRepository, MAX_RECOVERY_CONTEXT_CHARS } from "../../src/session/event-repository";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedEvents } from "./helpers";
import { runInSessionDO } from "./session-do-access";
import { initSchema } from "../../src/session/schema";

beforeEach(cleanD1Tables);

it("adds the bounded chronological access path to an existing session database", async () => {
  const { stub } = await initSession();
  const plan = await runInSessionDO(stub, (_instance, state) => {
    state.storage.sql.exec("DROP INDEX idx_events_recovery_chronology");
    initSchema(state.storage.sql);
    return state.storage.sql
      .exec(
        `EXPLAIN QUERY PLAN
      SELECT id FROM events INDEXED BY idx_events_recovery_chronology
      WHERE type IN ('user_message', 'token') AND message_id != ?
      ORDER BY created_at DESC, timeline_sequence DESC LIMIT ?`,
        "current",
        101
      )
      .toArray() as Array<{ detail: string }>;
  });
  expect(plan.some(({ detail }) => detail.includes("idx_events_recovery_chronology"))).toBe(true);
  expect(plan.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false);
});

it("reads the previous conversation from real DO storage independently of sandbox memory", async () => {
  const { stub } = await initSession();
  await seedEvents(stub, [
    {
      id: "previous-user",
      type: "user_message",
      messageId: "previous",
      data: JSON.stringify({ content: "Use X, never Y." }),
      createdAt: 1000,
    },
    {
      id: "previous-answer",
      type: "token",
      messageId: "previous",
      data: JSON.stringify({ content: "I will use X." }),
      createdAt: 1001,
    },
    {
      id: "follow-up",
      type: "user_message",
      messageId: "current",
      data: JSON.stringify({ content: "Continue." }),
      createdAt: 1002,
    },
  ]);

  // The replacement runtime owns none of these events. A newly constructed
  // repository must recover them from session storage, independently of it.
  const context = await runInSessionDO(stub, (_instance, state) =>
    new EventRepository(state.storage.sql, (callback) =>
      state.storage.transactionSync(callback)
    ).getRecoveryContext("current")
  );
  expect(context).toEqual({
    messages: [
      { role: "user", content: "Use X, never Y." },
      { role: "assistant", content: "I will use X." },
    ],
    truncated: false,
  });
});

it("retains the decision at the end of a cutoff event in real DO SQLite", async () => {
  const { stub } = await initSession();
  await seedEvents(stub, [
    {
      id: "large-answer",
      type: "token",
      messageId: "previous",
      createdAt: 1000,
      data: JSON.stringify({ content: "x".repeat(MAX_RECOVERY_CONTEXT_CHARS) + "Use X" }),
    },
  ]);
  const context = await runInSessionDO(stub, (_instance, state) =>
    new EventRepository(state.storage.sql, (callback) =>
      state.storage.transactionSync(callback)
    ).getRecoveryContext("current")
  );
  expect(context.messages[0].content.endsWith("Use X")).toBe(true);
  expect(context.messages[0].content).toHaveLength(MAX_RECOVERY_CONTEXT_CHARS);
  expect(context.truncated).toBe(true);
});
