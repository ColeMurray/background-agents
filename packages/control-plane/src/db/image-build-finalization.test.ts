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

const VALID_FINALIZATION_ROW = {
  id: "build-1",
  provider: "vercel",
  status: "building",
  provider_image_id: null,
  provider_session_id: "session-1",
  completion_hash: "completion-1",
  repository_shas: "[]",
  runtime_version: "v53",
  build_duration_seconds: null,
  error_message: null,
  finalization_lease_token: null,
  finalization_lease_expires_at: null,
  provider_session_cleanup_pending: 1,
  callback_token_used_at: 1_500,
  provider_operation_ref: "oi-image-build-1",
  provider_operation_deadline_at: 30_000,
  created_at: 1_000,
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
    // A provider value no build can run on: the row is data the store
    // validates, not a provider this deployment happens to have configured.
    ["provider", { provider: "fly" }],
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

describe("ImageBuildFinalizationStore finalization rows", () => {
  it("returns a valid finalization row with nullable fields", async () => {
    const store = new ImageBuildFinalizationStore(database(VALID_FINALIZATION_ROW));

    await expect(store.getBuild("build-1")).resolves.toEqual(VALID_FINALIZATION_ROW);
  });

  it.each([
    ["provider", { provider: "unknown" }],
    ["status", { status: "queued" }],
  ])("rejects a finalization row with invalid %s", async (_field, override) => {
    const store = new ImageBuildFinalizationStore(
      database({ ...VALID_FINALIZATION_ROW, ...override })
    );

    await expect(store.getBuild("build-1")).rejects.toThrow(
      "Malformed image build finalization row: build-1"
    );
  });

  it("rejects a partial finalization row", async () => {
    const partialRow: Record<string, unknown> = { ...VALID_FINALIZATION_ROW };
    delete partialRow.runtime_version;
    const store = new ImageBuildFinalizationStore(database(partialRow));

    await expect(store.getBuild("build-1")).rejects.toThrow(
      "Malformed image build finalization row: build-1"
    );
  });
});
