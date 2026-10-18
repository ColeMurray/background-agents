import { describe, expect, it } from "vitest";
import {
  PI_MIGRATION_RESERVATIONS,
  validateMigrationArtifacts,
  validateMigrationReservations,
} from "./pi-migration-reservations";

describe("Pi migration reservations", () => {
  it("assigns the cross-cutting feature migration ranges", () => {
    expect(PI_MIGRATION_RESERVATIONS).toEqual([
      {
        store: "session_do",
        version: 58,
        feature: "sandbox_execution",
        purpose: "sandbox execution requests",
      },
      {
        store: "session_do",
        version: 59,
        feature: "sandbox_execution",
        purpose: "sandbox execution lifecycle",
      },
      {
        store: "session_do",
        version: 60,
        feature: "external_actions",
        purpose: "external action approvals and execution",
      },
      {
        store: "d1",
        version: 90,
        feature: "external_actions",
        purpose: "external action authority",
      },
      { store: "d1", version: 91, feature: "mcp", purpose: "MCP authority" },
    ]);
    expect(() => validateMigrationReservations(PI_MIGRATION_RESERVATIONS)).not.toThrow();
  });

  it("rejects duplicate reservations within a migration store", () => {
    expect(() =>
      validateMigrationReservations([
        ...PI_MIGRATION_RESERVATIONS,
        {
          store: "session_do",
          version: 58,
          feature: "external_actions",
          purpose: "collision",
        },
      ])
    ).toThrow("Duplicate session_do migration reservation 58");
  });

  it("rejects duplicate migration artifacts even when their names differ", () => {
    expect(() =>
      validateMigrationArtifacts([
        { store: "d1", version: 90, name: "0090_external_actions.sql" },
        { store: "d1", version: 90, name: "0090_other.sql" },
      ])
    ).toThrow("Duplicate d1 migration artifact 90");
  });
});
