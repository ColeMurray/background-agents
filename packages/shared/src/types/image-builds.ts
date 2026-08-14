/**
 * Wire contract for the unified image-build subsystem.
 *
 * An image build bakes a provider image for a *scope* — either a single
 * repository or an environment (an ordered repository set). These types
 * mirror the D1 `image_builds` table and the repository provenance reported by
 * the sandbox runtime. They are consumed by the control plane and web BFF.
 */

import { z } from "zod";

/** Mirrors the `image_builds.status` column. */
export const imageBuildStatusSchema = z.enum(["building", "ready", "failed", "superseded"]);

export type ImageBuildStatus = z.infer<typeof imageBuildStatusSchema>;

/** Mirrors the `image_builds.scope_kind` column. */
export const imageBuildScopeKindSchema = z.enum(["repo", "environment"]);

export type ImageBuildScopeKind = z.infer<typeof imageBuildScopeKindSchema>;

/**
 * One repository's clone provenance at build time.
 *
 * A single cross-language document shape: produced by the sandbox runtime,
 * echoed through build callbacks, stored verbatim as one entry of the
 * `image_builds.repository_shas` JSON column, and compared against
 * `git ls-remote` by the rebuild cron. Keep the field names in sync with
 * `sandbox_runtime/entrypoint.py` rather than remapping at each boundary.
 */
export interface RepositoryShaEntry {
  repoOwner: string;
  repoName: string;
  baseSha: string;
}

/**
 * One build row as returned by the image-build status endpoints.
 *
 * Mirrors the D1 SELECT in the control plane's `db/image-builds.ts` —
 * snake_case column names pass through unmapped. `scope_id` is a lowercase
 * `owner/name` pair for repo scopes and an environment id for environment
 * scopes. `repositories_fingerprint` identifies the scope's repository set
 * as of the build — rows whose fingerprint differs from the scope's current
 * one are stale. `repository_shas` is the JSON-encoded `RepositoryShaEntry[]`
 * column value — `JSON.parse` before use. `provider` values come from the
 * control plane's provider union (deploy configuration, not part of this
 * contract).
 */
export const imageBuildRecordViewSchema = z.object({
  id: z.string(),
  scope_kind: imageBuildScopeKindSchema,
  scope_id: z.string(),
  provider: z.string(),
  status: imageBuildStatusSchema,
  repositories_fingerprint: z.string(),
  repository_shas: z.string(),
  runtime_version: z.string(),
  build_duration_seconds: z.number().nullable(),
  error_message: z.string().nullable(),
  created_at: z.number(),
});

export type ImageBuildRecordView = z.infer<typeof imageBuildRecordViewSchema>;

export const imageBuildStatusResponseSchema = z.object({
  images: z.array(imageBuildRecordViewSchema),
});

export type ImageBuildStatusResponse = z.infer<typeof imageBuildStatusResponseSchema>;
