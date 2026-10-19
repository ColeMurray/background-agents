import type { PiFeatureId } from "./pi-feature-capabilities";

export type MigrationStore = "session_do" | "d1";

export const PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID = 58;
export const PI_SESSION_DO_SANDBOX_EXECUTION_LIFECYCLE_MIGRATION_ID = 59;
export const PI_SESSION_DO_EXTERNAL_ACTIONS_MIGRATION_ID = 60;
export const PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID = 61;
export const PI_SESSION_DO_PI_PROJECTION_MIGRATION_ID = 62;
export const PI_SESSION_DO_REPOSITORY_EDITING_MIGRATION_ID = 63;
export const PI_D1_EXTERNAL_ACTIONS_MIGRATION_VERSION = 90;
export const PI_D1_MCP_MIGRATION_VERSION = 91;
export const PI_D1_SLACK_INGRESS_MIGRATION_VERSION = 92;
export const PI_D1_SLACK_MAPPING_MIGRATION_VERSION = 95;

export type PiMigrationOwner = PiFeatureId | "coreAuthority" | "piProjection" | "slackIngress";

export interface MigrationReservation {
  readonly store: MigrationStore;
  readonly version: number;
  readonly feature: PiMigrationOwner;
  readonly purpose: string;
}

export interface MigrationArtifact {
  readonly store: MigrationStore;
  readonly version: number;
  readonly name: string;
  readonly feature?: PiMigrationOwner;
}

export type MigrationReservationClaim = Pick<MigrationReservation, "store" | "version" | "feature">;

/**
 * Reserved migration numbers for the parallel first-class Pi feature branches.
 * D1 versions are rendered with four digits in filenames (90 becomes 0090).
 */
export const PI_MIGRATION_RESERVATIONS = [
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
] as const satisfies readonly MigrationReservation[];

export function validateMigrationReservations(reservations: readonly MigrationReservation[]): void {
  validateUniqueVersions(reservations, "reservation");
}

export function validateMigrationArtifacts(artifacts: readonly MigrationArtifact[]): void {
  validateUniqueVersions(artifacts, "artifact");
  for (const artifact of artifacts) {
    const reservation = findMigrationReservation(artifact);
    if (reservation && artifact.feature === undefined) {
      throw new Error(
        `Reserved ${artifact.store} migration artifact ${artifact.version} must declare feature ${reservation.feature}`
      );
    }
    if (artifact.feature !== undefined) {
      assertMigrationReservation({
        store: artifact.store,
        version: artifact.version,
        feature: artifact.feature,
      });
    }
  }
}

/** Prove that a feature owns this exact migration slot before materializing its artifact. */
export function assertMigrationReservation(claim: MigrationReservationClaim): void {
  const reservation = findMigrationReservation(claim);
  if (!reservation) {
    throw new Error(`${claim.store} migration ${claim.version} is not reserved`);
  }
  if (reservation.feature !== claim.feature) {
    throw new Error(
      `${claim.store} migration ${claim.version} is reserved for ${reservation.feature}, not ${claim.feature}`
    );
  }
}

function validateUniqueVersions(
  entries: readonly Pick<MigrationReservation, "store" | "version">[],
  kind: "reservation" | "artifact"
): void {
  const seen = new Set<string>();
  for (const { store, version } of entries) {
    const key = `${store}:${version}`;
    if (seen.has(key)) throw new Error(`Duplicate ${store} migration ${kind} ${version}`);
    seen.add(key);
  }
}

function findMigrationReservation(
  claim: Pick<MigrationReservation, "store" | "version">
): MigrationReservation | undefined {
  return PI_MIGRATION_RESERVATIONS.find(
    ({ store, version }) => store === claim.store && version === claim.version
  );
}

validateMigrationReservations(PI_MIGRATION_RESERVATIONS);
