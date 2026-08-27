/**
 * Wire contract for the unified image-build subsystem.
 *
 * An image build bakes a provider image for a *scope* — either a single
 * repository or an environment (an ordered repository set). These types
 * describe the public status API and the repository provenance reported by the
 * sandbox runtime. They are consumed by the control plane and web BFF.
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
export const repositoryShaEntrySchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  baseSha: z.string().min(1),
});

export type RepositoryShaEntry = z.infer<typeof repositoryShaEntrySchema>;

export const repositoryShasSchema = z.array(repositoryShaEntrySchema);

/**
 * One build row as returned by the image-build status endpoints.
 *
 * `scopeId` is a lowercase
 * `owner/name` pair for repo scopes and an environment id for environment
 * scopes. `repositoriesFingerprint` identifies the scope's repository set
 * as of the build — rows whose fingerprint differs from the scope's current
 * one are stale. `repositoryShas` is decoded at the control-plane storage
 * boundary; malformed historical values are represented as null. `provider`
 * values come from the control plane's provider union (deploy configuration,
 * not part of this contract).
 */
export const imageBuildRecordViewSchema = z.object({
  id: z.string(),
  scopeKind: imageBuildScopeKindSchema,
  scopeId: z.string(),
  provider: z.string(),
  status: imageBuildStatusSchema,
  repositoriesFingerprint: z.string(),
  repositoryShas: repositoryShasSchema.nullable(),
  runtimeVersion: z.string(),
  buildDurationSeconds: z.number().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.number(),
});

export type ImageBuildRecordView = z.infer<typeof imageBuildRecordViewSchema>;

export const imageBuildStatusResponseSchema = z.object({
  images: z.array(imageBuildRecordViewSchema),
});

export type ImageBuildStatusResponse = z.infer<typeof imageBuildStatusResponseSchema>;
