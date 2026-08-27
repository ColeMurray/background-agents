import { describe, expect, it } from "vitest";
import { ImageBuildStore } from "./image-builds";

/**
 * The exact public-safe storage columns. The status reads must project these
 * and only these — never the internal callback-token or provider-id
 * columns the `image_builds` table also carries.
 */
const PUBLIC_KEYS = [
  "id",
  "scopeKind",
  "scopeId",
  "provider",
  "status",
  "repositoriesFingerprint",
  "repositoryShas",
  "runtimeVersion",
  "buildDurationSeconds",
  "errorMessage",
  "createdAt",
].sort();

const INTERNAL_KEYS = [
  "callback_token_hash",
  "callback_token_expires_at",
  "callback_token_used_at",
  "provider_session_id",
  "provider_image_id",
];

/** A full table row, including the internal columns (Vercel-shape values). */
const FULL_ROW: Record<string, unknown> = {
  id: "b1",
  scope_kind: "environment",
  scope_id: "env_1",
  provider: "vercel",
  status: "ready",
  repositories_fingerprint: "fp",
  repository_shas: JSON.stringify([{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }]),
  runtime_version: "v53",
  build_duration_seconds: 12,
  error_message: null,
  created_at: 1000,
  callback_token_hash: "hash-secret",
  callback_token_expires_at: 2000,
  callback_token_used_at: null,
  provider_session_id: "session-secret",
  provider_image_id: "image-secret",
};

/**
 * Minimal D1 fake that emulates SQLite column projection: it returns only the
 * columns named in the SELECT list, so a `SELECT *` regression surfaces as a
 * leaked internal column rather than being masked by a canned row.
 */
function projectRow(query: string, source: Record<string, unknown>): Record<string, unknown> {
  const normalized = query.replace(/\s+/g, " ").trim();
  const match = /SELECT (.+?) FROM /.exec(normalized);
  if (!match) throw new Error(`Unexpected query: ${query}`);
  const columns = match[1].split(",").map((c) => c.trim());
  if (columns.length === 1 && columns[0] === "*") return { ...source };
  const projected: Record<string, unknown> = {};
  for (const column of columns) projected[column] = source[column];
  return projected;
}

function fakeDb(overrides: Record<string, unknown> = {}): D1Database {
  const source = { ...FULL_ROW, ...overrides };
  const statement = (query: string) => ({
    bind: () => statement(query),
    all: async () => ({ results: [projectRow(query, source)] }),
    first: async () => projectRow(query, source),
    run: async () => ({ meta: { changes: 0 } }),
  });
  return { prepare: (query: string) => statement(query) } as unknown as D1Database;
}

describe("ImageBuildStore status projection", () => {
  it("getStatus maps storage fields and decoded provenance to the public model", async () => {
    const rows = await new ImageBuildStore(fakeDb()).getStatus({
      kind: "environment",
      id: "env_1",
    });

    expect(rows).toEqual([
      {
        id: "b1",
        scopeKind: "environment",
        scopeId: "env_1",
        provider: "vercel",
        status: "ready",
        repositoriesFingerprint: "fp",
        repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
        runtimeVersion: "v53",
        buildDurationSeconds: 12,
        errorMessage: null,
        createdAt: 1000,
      },
    ]);
    for (const key of INTERNAL_KEYS) expect(rows[0]).not.toHaveProperty(key);
  });

  it.each([
    ["empty", "[]", []],
    ["malformed JSON", "not-json", null],
    ["invalid entry", JSON.stringify([{ repoOwner: "acme", repoName: "web" }]), null],
  ])("maps %s stored provenance safely", async (_description, stored, expected) => {
    const rows = await new ImageBuildStore(fakeDb({ repository_shas: stored })).getStatus({
      kind: "environment",
      id: "env_1",
    });

    expect(rows[0].repositoryShas).toEqual(expected);
  });

  it("getStatusForEnabledScopes returns exactly the wire columns", async () => {
    const rows = await new ImageBuildStore(fakeDb()).getStatusForEnabledScopes([
      { kind: "environment", id: "env_1" },
    ]);

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(PUBLIC_KEYS);
    for (const key of INTERNAL_KEYS) expect(rows[0]).not.toHaveProperty(key);
  });
});
