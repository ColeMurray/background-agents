import { expect, it } from "vitest";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { ExternalActionAuditStore } from "./external-action-audit";

it("writes an idempotent applied audit record for a human approval", async () => {
  const recorded = { sql: "", values: [] as unknown[] };
  const statement: SqlStatement = {
    bind(...values) {
      recorded.values = values;
      return statement;
    },
    first: async () => null,
    all: async () => ({ results: [], meta: { changes: 0 } }),
    run: async () => ({ results: [], meta: { changes: 1 } }),
  };
  const db: SqlDatabase = {
    prepare(sql) {
      recorded.sql = sql;
      return statement;
    },
    batch: async () => [],
  };

  await new ExternalActionAuditStore(db).write({
    requestId: "request-1",
    actor: { kind: "user", userId: "user-1" },
    action: "external_action.approved",
    actionId: "action-1",
    sessionId: "session-1",
    teamId: "team-1",
    beforeState: "awaiting_approval",
    afterState: "approved",
    revision: 2,
    occurredAt: 1_700_000_000_000,
  });

  expect(recorded.sql).toContain("ON CONFLICT(id) DO NOTHING");
  expect(recorded.values).toEqual(
    expect.arrayContaining([
      "external-action:action-1:2:external_action.approved",
      1_700_000_000_000,
      "request-1",
      "user",
      "user-1",
      "external_action.approved",
      "action-1",
      "team-1",
    ])
  );
});

it("records a system decision as a service principal, never as a user", async () => {
  const recorded = { sql: "", values: [] as unknown[] };
  const statement: SqlStatement = {
    bind(...values) {
      recorded.values = values;
      return statement;
    },
    first: async () => null,
    all: async () => ({ results: [], meta: { changes: 0 } }),
    run: async () => ({ results: [], meta: { changes: 1 } }),
  };
  const db: SqlDatabase = {
    prepare(sql) {
      recorded.sql = sql;
      return statement;
    },
    batch: async () => [],
  };

  await new ExternalActionAuditStore(db).write({
    requestId: "request-2",
    actor: { kind: "service", service: "external-action-expiry" },
    action: "external_action.cancelled",
    actionId: "action-2",
    sessionId: "session-1",
    teamId: "team-1",
    beforeState: "awaiting_approval",
    afterState: "cancelled",
    revision: 3,
    occurredAt: 1_700_000_001_000,
  });

  expect(recorded.values).toEqual(
    expect.arrayContaining(["service", null, "external-action-expiry", 1_700_000_001_000])
  );
});
