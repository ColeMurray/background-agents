import { describe, expect, it } from "vitest";
import {
  PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
  PI_D1_MCP_MIGRATION_VERSION,
  PI_D1_SLACK_INGRESS_MIGRATION_VERSION,
  PI_D1_SLACK_MAPPING_MIGRATION_VERSION,
  PI_MIGRATION_RESERVATIONS,
  PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID,
  PI_SESSION_DO_CONTROLS_MIGRATION_ID,
  PI_SESSION_DO_EXTERNAL_ACTION_LIFECYCLE_MIGRATION_ID,
  PI_SESSION_DO_EXTERNAL_ACTIONS_MIGRATION_ID,
  PI_SESSION_DO_PI_PROJECTION_MIGRATION_ID,
  PI_SESSION_DO_REPOSITORY_EDITING_MIGRATION_ID,
  PI_SESSION_DO_SANDBOX_EXECUTION_LIFECYCLE_MIGRATION_ID,
  PI_SESSION_DO_SANDBOX_EXECUTION_AUTHORITY_MIGRATION_ID,
  PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID,
  assertMigrationReservation,
  validateMigrationArtifacts,
  validateMigrationReservations,
} from "./pi-migration-reservations";

describe("Pi migration reservations", () => {
  it("assigns the cross-cutting feature migration ranges", () => {
    expect([
      PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID,
      PI_SESSION_DO_SANDBOX_EXECUTION_LIFECYCLE_MIGRATION_ID,
      PI_SESSION_DO_EXTERNAL_ACTIONS_MIGRATION_ID,
      PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID,
      PI_SESSION_DO_PI_PROJECTION_MIGRATION_ID,
      PI_SESSION_DO_REPOSITORY_EDITING_MIGRATION_ID,
      PI_SESSION_DO_CONTROLS_MIGRATION_ID,
      PI_SESSION_DO_SANDBOX_EXECUTION_AUTHORITY_MIGRATION_ID,
      PI_SESSION_DO_EXTERNAL_ACTION_LIFECYCLE_MIGRATION_ID,
      PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
      PI_D1_MCP_MIGRATION_VERSION,
      PI_D1_SLACK_INGRESS_MIGRATION_VERSION,
      PI_D1_SLACK_MAPPING_MIGRATION_VERSION,
    ]).toEqual([58, 59, 60, 61, 62, 63, 64, 65, 66, 90, 91, 92, 95]);
    expect(PI_MIGRATION_RESERVATIONS).toEqual([
      {
        store: "session_do",
        version: PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID,
        feature: "sandboxExecution",
        purpose: "sandbox execution requests",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_SANDBOX_EXECUTION_LIFECYCLE_MIGRATION_ID,
        feature: "sandboxExecution",
        purpose: "sandbox execution lifecycle",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_EXTERNAL_ACTIONS_MIGRATION_ID,
        feature: "externalActions",
        purpose: "external action approvals and execution",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID,
        feature: "coreAuthority",
        purpose: "creation-time Pi capability authority",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_PI_PROJECTION_MIGRATION_ID,
        feature: "piProjection",
        purpose: "Pi dispatch CAS and projection sequence",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_REPOSITORY_EDITING_MIGRATION_ID,
        feature: "repositoryEditing",
        purpose: "Pi repository diff publication generation fence",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_CONTROLS_MIGRATION_ID,
        feature: "piControls",
        purpose: "Pi native control receipts",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_SANDBOX_EXECUTION_AUTHORITY_MIGRATION_ID,
        feature: "sandboxExecution",
        purpose: "sandbox execution authority, cancellation, and retention",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_EXTERNAL_ACTION_LIFECYCLE_MIGRATION_ID,
        feature: "externalActions",
        purpose: "external action approval expiry, cancellation, and audit occurrence time",
      },
      {
        store: "d1",
        version: PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
        feature: "externalActions",
        purpose: "external action authority",
      },
      {
        store: "d1",
        version: PI_D1_MCP_MIGRATION_VERSION,
        feature: "mcp",
        purpose: "MCP authority",
      },
      {
        store: "d1",
        version: PI_D1_SLACK_INGRESS_MIGRATION_VERSION,
        feature: "slackIngress",
        purpose: "durable Slack ingress receipts",
      },
      {
        store: "d1",
        version: PI_D1_SLACK_MAPPING_MIGRATION_VERSION,
        feature: "slackIngress",
        purpose: "durable Slack thread mapping projection",
      },
    ]);
    expect(() => validateMigrationReservations(PI_MIGRATION_RESERVATIONS)).not.toThrow();
  });

  it("rejects duplicate reservations within a migration store", () => {
    expect(() =>
      validateMigrationReservations([
        ...PI_MIGRATION_RESERVATIONS,
        {
          store: "session_do",
          version: PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID,
          feature: "externalActions",
          purpose: "collision",
        },
      ])
    ).toThrow("Duplicate session_do migration reservation 58");
  });

  it("rejects duplicate migration artifacts even when their names differ", () => {
    expect(() =>
      validateMigrationArtifacts([
        {
          store: "d1",
          version: PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
          name: "0090_external_actions.sql",
        },
        {
          store: "d1",
          version: PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
          name: "0090_other.sql",
        },
      ])
    ).toThrow("Duplicate d1 migration artifact 90");
  });

  it("rejects wrong, swapped, and unreserved feature claims", () => {
    expect(() =>
      assertMigrationReservation({
        store: "session_do",
        version: PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID,
        feature: "externalActions",
      })
    ).toThrow("reserved for sandboxExecution, not externalActions");
    expect(() =>
      assertMigrationReservation({
        store: "session_do",
        version: PI_SESSION_DO_EXTERNAL_ACTIONS_MIGRATION_ID,
        feature: "sandboxExecution",
      })
    ).toThrow("reserved for externalActions, not sandboxExecution");
    expect(() =>
      assertMigrationReservation({
        store: "d1",
        version: PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
        feature: "mcp",
      })
    ).toThrow("reserved for externalActions, not mcp");
    expect(() =>
      assertMigrationReservation({
        store: "d1",
        version: PI_D1_MCP_MIGRATION_VERSION,
        feature: "externalActions",
      })
    ).toThrow("reserved for mcp, not externalActions");
    expect(() =>
      assertMigrationReservation({
        store: "session_do",
        version: PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID,
        feature: "mcp",
      })
    ).toThrow("reserved for coreAuthority, not mcp");
    expect(() =>
      assertMigrationReservation({ store: "session_do", version: 62, feature: "mcp" })
    ).toThrow("reserved for piProjection, not mcp");
  });

  it("requires an owner when an artifact occupies a reserved version", () => {
    expect(() =>
      validateMigrationArtifacts([
        {
          store: "d1",
          version: PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
          name: "0090_external_actions.sql",
        },
      ])
    ).toThrow("Reserved d1 migration artifact 90 must declare feature externalActions");

    expect(() =>
      validateMigrationArtifacts([
        {
          store: "d1",
          version: PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION,
          name: "0090_external_actions.sql",
          feature: "externalActions",
        },
      ])
    ).not.toThrow();
  });
});
