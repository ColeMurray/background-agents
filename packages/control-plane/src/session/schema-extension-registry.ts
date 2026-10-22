import type { SchemaMigration } from "./schema";

const registeredMigrations: SchemaMigration[] = [];

/** Composition-root hook for deployment-only SessionDO migrations. */
export function registerSessionSchemaMigrations(migrations: readonly SchemaMigration[]): void {
  for (const migration of migrations) {
    if (!registeredMigrations.some((candidate) => candidate.id === migration.id)) {
      registeredMigrations.push(migration);
    }
  }
}

export function sessionSchemaExtensionMigrations(): readonly SchemaMigration[] {
  return registeredMigrations;
}
