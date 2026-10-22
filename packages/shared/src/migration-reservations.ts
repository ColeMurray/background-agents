/**
 * The feature that owns a migration slot.
 *
 * A migration belongs to exactly one feature, and the registry proves it: a
 * migration that claims a slot another feature owns is refused before it is
 * applied.
 */
export type MigrationOwner =
  | "scratchWorkspace"
  | "repositoryEditing"
  | "codeMode"
  | "sandboxExecution"
  | "mcp"
  | "browser"
  | "memory"
  | "coreAuthority"
  | "piProjection"
  | "piControls"
  | "slackIngress";

/**
 * The stores that carry a tracked migration registry.
 *
 * `session_do` is the Session Durable Object's own database, `pi_do` is the Pi
 * Durable Object's own database, and `d1` is the deployment's global store.
 * The two Durable Object stores are separate databases with separate
 * numbering spaces: `pi_do` starts again at 1.
 */
export type MigrationStore = "session_do" | "pi_do" | "d1";

export const PI_DO_OUTBOX_MIGRATION_ID = 1;
export const PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID = 2;
export const PI_DO_TRUSTED_USAGE_MIGRATION_ID = 3;
export const PI_DO_TURN_AUTHORITY_MIGRATION_ID = 4;
/**
 * The session-DO migration the Pi result receipts took.
 *
 * It is reserved for the same reason every other id here is reserved: the
 * registry skips by id, so an id that is taken but unreserved is an id
 * upstream can reuse. Upstream's next session-DO migration would then be
 * skipped on any session where Pi's migration had already run.
 */
export const PI_SESSION_DO_RESULT_RECEIPTS_MIGRATION_ID = 57;
export const PI_SESSION_DO_SANDBOX_EXECUTION_REQUESTS_MIGRATION_ID = 58;
export const PI_SESSION_DO_SANDBOX_EXECUTION_LIFECYCLE_MIGRATION_ID = 59;
export const PI_SESSION_DO_CORE_AUTHORITY_MIGRATION_ID = 61;
export const PI_SESSION_DO_PI_PROJECTION_MIGRATION_ID = 62;
export const PI_SESSION_DO_REPOSITORY_EDITING_MIGRATION_ID = 63;
export const PI_SESSION_DO_CONTROLS_MIGRATION_ID = 64;
export const PI_SESSION_DO_SANDBOX_EXECUTION_AUTHORITY_MIGRATION_ID = 65;
export const IN_PROCESS_CONTROL_MESSAGE_MIGRATION_ID = 67;
export const PI_D1_HARNESS_DISCRIMINATOR_MIGRATION_VERSION = 90;
export const PI_D1_MCP_REVIEWED_TOOLS_MIGRATION_VERSION = 91;
export const PI_D1_SLACK_INGRESS_MIGRATION_VERSION = 92;
export const PI_D1_SLACK_MAPPING_MIGRATION_VERSION = 93;
/**
 * The dormant foundation of the personal MCP lane.
 *
 * The core carries the tables but no lane: nothing grants a connection, and
 * nothing reads one. The version sits high so the core's own migrations keep
 * the low numbers the deployment already applied.
 */
export const PI_D1_MCP_OAUTH_FOUNDATION_MIGRATION_VERSION = 9002;

export interface MigrationReservation {
  readonly store: MigrationStore;
  readonly version: number;
  readonly feature: MigrationOwner;
  readonly purpose: string;
}

export interface MigrationArtifact {
  readonly store: MigrationStore;
  readonly version: number;
  readonly name: string;
  readonly feature?: MigrationOwner;
}

export type MigrationReservationClaim = Pick<MigrationReservation, "store" | "version" | "feature">;

/**
 * Reserved migration numbers for the parallel first-class Pi feature branches.
 * D1 versions are rendered with four digits in filenames (90 becomes 0090).
 */
export const MIGRATION_RESERVATIONS = [
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
    store: "pi_do",
    version: PI_DO_TRUSTED_USAGE_MIGRATION_ID,
    feature: "coreAuthority",
    purpose: "Pi trusted usage accounting",
  },
  {
    store: "pi_do",
    version: PI_DO_TURN_AUTHORITY_MIGRATION_ID,
    feature: "coreAuthority",
    purpose: "Pi turn deadlines and action ceilings",
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
    store: "session_do",
    version: IN_PROCESS_CONTROL_MESSAGE_MIGRATION_ID,
    feature: "coreAuthority",
    purpose: "canonical queued controls for in-process harnesses",
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
  return MIGRATION_RESERVATIONS.find(
    ({ store, version }) => store === claim.store && version === claim.version
  );
}

validateMigrationReservations(MIGRATION_RESERVATIONS);
