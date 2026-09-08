/**
 * Shared D1 seed/read helpers for the image-build integration suites
 * (image-builds.test.ts, image-build-stale-recovery.test.ts).
 */
import { env } from "cloudflare:test";
import { EnvironmentStore } from "../../src/db/environments";
import type { ImageBuildScope } from "../../src/image-builds/model";

export const RUNTIME_VERSION = "v53-list-native-runtime";
export const REPOSITORY_SHAS = [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }];

export function environmentScope(id: string): ImageBuildScope {
  return { kind: "environment", id };
}

export async function seedEnvironment(opts?: {
  id?: string;
  name?: string;
  prebuildEnabled?: boolean;
  repositories?: [string, string, number, string][];
}): Promise<string> {
  const store = new EnvironmentStore(env.DB);
  const id = opts?.id ?? `env_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await store.create(
    {
      id,
      name: opts?.name ?? `Seeded ${id}`,
      description: null,
      prebuild_enabled: opts?.prebuildEnabled ? 1 : 0,
      channel_associations: null,
      created_at: now,
      updated_at: now,
    },
    (opts?.repositories ?? [["acme", "web", 1, "main"]]).map(([o, n, rid, b], position) => ({
      position,
      repo_owner: o,
      repo_name: n,
      repo_id: rid,
      base_branch: b,
    }))
  );
  return id;
}

/** Raw insert when a test needs to control created_at/status/artifact. */
export async function seedImageRowForScope(
  scope: ImageBuildScope,
  row: {
    id: string;
    status: string;
    provider?: string;
    providerImageId?: string | null;
    repositoriesFingerprint?: string;
    runtimeVersion?: string;
    createdAt?: number;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO image_builds
       (id, scope_kind, scope_id, provider, provider_image_id, repositories_fingerprint,
        repository_shas, runtime_version, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      scope.kind,
      scope.id,
      row.provider ?? "modal",
      row.providerImageId ?? null,
      row.repositoriesFingerprint ?? "fp-seeded",
      JSON.stringify(REPOSITORY_SHAS),
      row.runtimeVersion ?? RUNTIME_VERSION,
      row.status,
      row.createdAt ?? Date.now()
    )
    .run();
}

export async function seedImageRow(row: {
  id: string;
  environmentId: string;
  status: string;
  provider?: string;
  providerImageId?: string | null;
  repositoriesFingerprint?: string;
  createdAt?: number;
}): Promise<void> {
  await seedImageRowForScope(environmentScope(row.environmentId), row);
}

export async function getRow(id: string) {
  return env.DB.prepare("SELECT * FROM image_builds WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}
