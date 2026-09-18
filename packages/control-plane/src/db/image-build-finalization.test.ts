import { describe, expect, it, vi } from "vitest";
import { ImageBuildFinalizationStore } from "./image-build-finalization";
import type { SqlDatabase, SqlStatement } from "./sql-database";

const VALID_CALLBACK_ROW = {
  id: "build-1",
  scope_kind: "repo",
  scope_id: "acme/web",
  provider: "vercel",
  provider_session_id: "session-1",
  status: "building",
  callback_token_hash: "token-hash",
  callback_token_expires_at: 2_000,
  callback_token_used_at: null,
  completion_hash: null,
};

function database(row: Record<string, unknown> | null): SqlDatabase {
  return {
    prepare(): SqlStatement {
      const statement: SqlStatement = {
        bind: () => statement,
        async first<T>() {
          return row as T | null;
        },
        run: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
        all: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
      };
      return statement;
    },
    batch: vi.fn(async () => []),
  };
}

describe("ImageBuildFinalizationStore callback rows", () => {
  it("authorizes a valid building callback row with nullable fields", async () => {
    const store = new ImageBuildFinalizationStore(database(VALID_CALLBACK_ROW));

    await expect(
      store.authorizeCompletionCallback({
        buildId: "build-1",
        providerSessionId: "session-1",
        tokenHash: "token-hash",
        now: 1_000,
      })
    ).resolves.toEqual({
      id: "build-1",
      scope: { kind: "repo", id: "acme/web" },
      provider: "vercel",
      status: "building",
    });
  });

  it.each([
    ["provider", { provider: "daytona" }],
    ["scope kind", { scope_kind: "workspace" }],
  ])("rejects an otherwise-authorizable callback row with invalid %s", async (_field, override) => {
    const store = new ImageBuildFinalizationStore(database({ ...VALID_CALLBACK_ROW, ...override }));

    await expect(
      store.authorizeCompletionCallback({
        buildId: "build-1",
        providerSessionId: "session-1",
        tokenHash: "token-hash",
        now: 1_000,
      })
    ).resolves.toBeNull();
  });

  it("rejects a partial callback row", async () => {
    const partialRow: Record<string, unknown> = { ...VALID_CALLBACK_ROW };
    delete partialRow.scope_id;
    const store = new ImageBuildFinalizationStore(database(partialRow));

    await expect(
      store.authorizeCompletionCallback({
        buildId: "build-1",
        providerSessionId: "session-1",
        tokenHash: "token-hash",
        now: 1_000,
      })
    ).resolves.toBeNull();
  });
});
