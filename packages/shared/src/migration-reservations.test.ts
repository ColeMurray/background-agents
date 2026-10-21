import { describe, expect, it } from "vitest";
import {
  PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION,
  PI_D1_MCP_OAUTH_FOUNDATION_MIGRATION_VERSION,
  PI_D1_MCP_REVIEWED_TOOLS_MIGRATION_VERSION,
  PI_D1_SLACK_INGRESS_MIGRATION_VERSION,
  PI_D1_SLACK_MAPPING_MIGRATION_VERSION,
  PI_DO_OUTBOX_MIGRATION_ID,
  PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID,
  MIGRATION_RESERVATIONS,
  PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID,
  PI_SESSION_DO_CONTROLS_MIGRATION_ID,
  PI_SESSION_DO_PI_PROJECTION_MIGRATION_ID,
  PI_SESSION_DO_REPOSITORY_EDITING_MIGRATION_ID,
  PI_SESSION_DO_SANDBOX_EXECUTION_LIFECYCLE_MIGRATION_ID,
  PI_SESSION_DO_SANDBOX_EXECUTION_AUTHORITY_MIGRATION_ID,
  PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID,
  PI_SESSION_DO_RESULT_RECEIPTS_MIGRATION_ID,
  assertMigrationReservation,
  validateMigrationArtifacts,
  validateMigrationReservations,
} from "./migration-reservations";

describe("Pi migration reservations", () => {
  it("assigns the cross-cutting feature migration ranges", () => {
    expect([
      PI_DO_OUTBOX_MIGRATION_ID,
      PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID,
      PI_SESSION_DO_RESULT_RECEIPTS_MIGRATION_ID,
      PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID,
      PI_SESSION_DO_SANDBOX_EXECUTION_LIFECYCLE_MIGRATION_ID,
      PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID,
      PI_SESSION_DO_PI_PROJECTION_MIGRATION_ID,
      PI_SESSION_DO_REPOSITORY_EDITING_MIGRATION_ID,
      PI_SESSION_DO_CONTROLS_MIGRATION_ID,
      PI_SESSION_DO_SANDBOX_EXECUTION_AUTHORITY_MIGRATION_ID,
      PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION,
      PI_D1_MCP_REVIEWED_TOOLS_MIGRATION_VERSION,
      PI_D1_SLACK_INGRESS_MIGRATION_VERSION,
      PI_D1_SLACK_MAPPING_MIGRATION_VERSION,
      PI_D1_MCP_OAUTH_FOUNDATION_MIGRATION_VERSION,
    ]).toEqual([1, 2, 57, 58, 59, 61, 62, 63, 64, 65, 90, 91, 92, 93, 9002]);
    expect(MIGRATION_RESERVATIONS).toEqual([
      {
        store: "pi_do",
        version: PI_DO_OUTBOX_MIGRATION_ID,
        feature: "piProjection",
        purpose: "Pi projection outbox and finalization tombstones",
      },
      {
        store: "pi_do",
        version: PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID,
        feature: "repositoryEditing",
        purpose: "Pi repository diff publication outbox",
      },
      {
        store: "session_do",
        version: PI_SESSION_DO_RESULT_RECEIPTS_MIGRATION_ID,
        feature: "piProjection",
        purpose: "Pi result projection receipts",
      },
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
        store: "d1",
        version: PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION,
        feature: "coreAuthority",
        purpose: "The constrained harness discriminator, with the DO harness added",
      },
      {
        store: "d1",
        version: PI_D1_MCP_REVIEWED_TOOLS_MIGRATION_VERSION,
        feature: "mcp",
        purpose: "the reviewed read-only catalogue of the deployment's shared MCP servers",
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
      {
        store: "d1",
        version: PI_D1_MCP_OAUTH_FOUNDATION_MIGRATION_VERSION,
        feature: "mcp",
        purpose: "the dormant foundation of the personal MCP lane",
      },
    ]);
    expect(() => validateMigrationReservations(MIGRATION_RESERVATIONS)).not.toThrow();
  });

  it("rejects duplicate reservations within a migration store", () => {
    expect(() =>
      validateMigrationReservations([
        ...MIGRATION_RESERVATIONS,
        {
          store: "session_do",
          version: PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID,
          feature: "codeMode",
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
          version: PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION,
          name: "0090_durable_object_harness.sql",
        },
        {
          store: "d1",
          version: PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION,
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
        feature: "codeMode",
      })
    ).toThrow("reserved for sandboxExecution, not codeMode");
    expect(() =>
      assertMigrationReservation({
        store: "session_do",
        version: PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID,
        feature: "sandboxExecution",
      })
    ).toThrow("reserved for coreAuthority, not sandboxExecution");
    expect(() =>
      assertMigrationReservation({
        store: "d1",
        version: PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION,
        feature: "slackIngress",
      })
    ).toThrow("reserved for coreAuthority, not slackIngress");
    expect(() =>
      assertMigrationReservation({
        store: "d1",
        version: PI_D1_SLACK_INGRESS_MIGRATION_VERSION,
        feature: "coreAuthority",
      })
    ).toThrow("reserved for slackIngress, not coreAuthority");
    expect(() =>
      assertMigrationReservation({
        store: "session_do",
        version: PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID,
        feature: "slackIngress",
      })
    ).toThrow("reserved for coreAuthority, not slackIngress");
    expect(() =>
      assertMigrationReservation({ store: "session_do", version: 62, feature: "slackIngress" })
    ).toThrow("reserved for piProjection, not slackIngress");
  });

  it("requires an owner when an artifact occupies a reserved version", () => {
    expect(() =>
      validateMigrationArtifacts([
        {
          store: "d1",
          version: PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION,
          name: "0090_durable_object_harness.sql",
        },
      ])
    ).toThrow("Reserved d1 migration artifact 90 must declare feature coreAuthority");

    expect(() =>
      validateMigrationArtifacts([
        {
          store: "d1",
          version: PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION,
          name: "0090_durable_object_harness.sql",
          feature: "coreAuthority",
        },
      ])
    ).not.toThrow();
  });
});
