import type { PiFeatureId } from "./pi-feature-capabilities";

export type MigrationStore = "session_do" | "d1";

export interface MigrationReservation {
  readonly store: MigrationStore;
  readonly version: number;
  readonly feature: PiFeatureId;
  readonly purpose: string;
}

export interface MigrationArtifact {
  readonly store: MigrationStore;
  readonly version: number;
  readonly name: string;
}

/**
 * Reserved migration numbers for the parallel first-class Pi feature branches.
 * D1 versions are rendered with four digits in filenames (90 becomes 0090).
 */
export const PI_MIGRATION_RESERVATIONS = [
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
] as const satisfies readonly MigrationReservation[];

export function validateMigrationReservations(reservations: readonly MigrationReservation[]): void {
  validateUniqueVersions(reservations, "reservation");
}

export function validateMigrationArtifacts(artifacts: readonly MigrationArtifact[]): void {
  validateUniqueVersions(artifacts, "artifact");
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
