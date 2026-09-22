import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { SandboxShutdownRepository, type ShutdownRecord } from "./sandbox-shutdown-repository";
import { SessionStorageIntegrityError } from "./types";

function record(overrides: Partial<ShutdownRecord> = {}): ShutdownRecord {
  return {
    phase: "running",
    generation: { sandboxId: "sandbox-1", createdAt: 1_000 },
    providerObjectId: "provider-1",
    lifetimeKind: "finite",
    expiresAtMs: 20_000,
    drainAtMs: 10_000,
    generationReady: false,
    ...overrides,
  };
}

function repository() {
  const db = new DatabaseSync(":memory:");
  const { sql } = createNodeSqlStorage(db);
  initSchema(sql);
  return { db, sql, repository: new SandboxShutdownRepository(sql) };
}

describe("SandboxShutdownRepository", () => {
  it("distinguishes missing state from a stored running generation", () => {
    const fixture = repository();
    expect(fixture.repository.read()).toBeNull();

    fixture.repository.write(record());
    expect(fixture.repository.read()).toEqual(record());
    fixture.db.close();
  });

  it("round-trips an explicit legacy generation without a drain deadline", () => {
    const fixture = repository();
    const legacy = record({ lifecyclePolicy: "legacy", drainAtMs: null });

    fixture.repository.write(legacy);

    expect(fixture.repository.read()).toEqual(legacy);
    fixture.db.close();
  });

  it("atomically replaces the singleton while preserving a verified receipt", () => {
    const fixture = repository();
    fixture.repository.write(record());
    const saved = record({
      phase: "saved",
      sourceRetired: true,
      generationReady: true,
      operationId: "operation-1",
      receipt: {
        kind: "snapshot",
        artifactId: "image-1",
        provider: "modal",
        savedAtMs: 15_000,
        runtimeVersion: "runtime-1",
      },
      savedAtMs: 15_000,
    });

    fixture.repository.write(saved);

    expect(fixture.repository.read()).toEqual(saved);
    expect(
      fixture.sql.exec("SELECT COUNT(*) AS count FROM sandbox_preservation").toArray()
    ).toEqual([{ count: 1 }]);
    fixture.db.close();
  });

  it("round-trips a restoring phase only with its actionable receipt", () => {
    const fixture = repository();
    const restoring = record({
      phase: "restoring",
      restoreInvoked: false,
      receipt: {
        kind: "snapshot",
        artifactId: "image-1",
        provider: "modal",
        savedAtMs: 15_000,
        runtimeVersion: "runtime-1",
      },
    });

    fixture.repository.write(restoring);
    expect(fixture.repository.read()).toEqual(restoring);
    expect(() => fixture.repository.write({ ...restoring, receipt: undefined })).toThrow();
    fixture.db.close();
  });

  it("fails closed on malformed persisted state", () => {
    const fixture = repository();
    fixture.sql.exec(
      "INSERT INTO sandbox_preservation (singleton, state) VALUES (1, ?)",
      JSON.stringify({ phase: "saved", generation: { sandboxId: "sandbox-1" } })
    );

    expect(() => fixture.repository.read()).toThrow(SessionStorageIntegrityError);
    fixture.db.close();
  });

  it("rejects a structurally complete saved phase without a verified receipt", () => {
    const fixture = repository();
    fixture.sql.exec(
      "INSERT INTO sandbox_preservation (singleton, state) VALUES (1, ?)",
      JSON.stringify({
        ...record(),
        phase: "saved",
        provider: "modal",
        generationReady: true,
        operationId: "operation-1",
        savedAtMs: 15_000,
      })
    );

    expect(() => fixture.repository.read()).toThrow(SessionStorageIntegrityError);
    fixture.db.close();
  });

  it("rejects invalid writes before replacing the last valid record", () => {
    const fixture = repository();
    fixture.repository.write(record());

    expect(() =>
      fixture.repository.write({ ...record(), generation: { sandboxId: "", createdAt: 1_000 } })
    ).toThrow();
    expect(fixture.repository.read()).toEqual(record());
    fixture.db.close();
  });
});
