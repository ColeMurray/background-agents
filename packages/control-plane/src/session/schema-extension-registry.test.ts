import { describe, expect, it } from "vitest";
import {
  registerSessionSchemaMigrations,
  sessionSchemaExtensionMigrations,
} from "./schema-extension-registry";
import type { SchemaMigration } from "./schema";

describe("SessionDO schema extension registry", () => {
  it("accepts an exact repeated registration only once", () => {
    const migration: SchemaMigration = {
      id: 90_001,
      description: "test-owned extension",
      feature: "externalActions",
      run: "CREATE TABLE test_owned_extension (id TEXT PRIMARY KEY)",
    };

    registerSessionSchemaMigrations([migration]);
    registerSessionSchemaMigrations([migration]);

    expect(sessionSchemaExtensionMigrations().filter(({ id }) => id === migration.id)).toEqual([
      migration,
    ]);
  });

  it("fails registration when another extension claims an existing id", () => {
    const migration: SchemaMigration = {
      id: 90_002,
      description: "first owner",
      feature: "externalActions",
      run: "CREATE TABLE first_owner (id TEXT PRIMARY KEY)",
    };
    registerSessionSchemaMigrations([migration]);

    expect(() =>
      registerSessionSchemaMigrations([
        {
          ...migration,
          description: "colliding owner",
          feature: "sandboxExecution",
          run: "CREATE TABLE colliding_owner (id TEXT PRIMARY KEY)",
        },
      ])
    ).toThrow("SessionDO schema migration id 90002 is already registered");
    expect(sessionSchemaExtensionMigrations().filter(({ id }) => id === migration.id)).toEqual([
      migration,
    ]);
  });
});
