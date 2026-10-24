import type { SchemaMigration } from "./schema";

const registeredMigrations: SchemaMigration[] = [];

/** Composition-root hook for deployment-only SessionDO migrations. */
export function registerSessionSchemaMigrations(migrations: readonly SchemaMigration[]): void {
  for (const migration of migrations) {
    const existing = registeredMigrations.find((candidate) => candidate.id === migration.id);
    if (!existing) {
      registeredMigrations.push(migration);
      continue;
    }
    if (sameMigration(existing, migration)) continue;
    throw new Error(
      `SessionDO schema migration id ${migration.id} is already registered by ${describeOwner(existing)}`
    );
  }
}

export function sessionSchemaExtensionMigrations(): readonly SchemaMigration[] {
  return registeredMigrations;
}

function sameMigration(left: SchemaMigration, right: SchemaMigration): boolean {
  return (
    left.id === right.id &&
    left.description === right.description &&
    left.feature === right.feature &&
    left.run === right.run
  );
}

function describeOwner(migration: SchemaMigration): string {
  return migration.feature
    ? `feature ${migration.feature} (${migration.description})`
    : migration.description;
}
