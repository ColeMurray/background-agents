/**
 * Wire contract for the unified image-build subsystem.
 *
 * An image build bakes a provider image for a *scope* — either a single
 * repository or an environment (an ordered repository set). These types
 * mirror the D1 `image_builds` table and the Modal worker callback payloads;
 * they are consumed by the control plane, the web BFF, and (by comment
 * convention) the Python data plane.
 */

/** Mirrors the `image_builds.status` column. */
export type ImageBuildStatus = "building" | "ready" | "failed" | "superseded";

/** Mirrors the `image_builds.scope_kind` column. */
export type ImageBuildScopeKind = "repo" | "environment";

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
 * column value — `JSON.parse` before use; `ImageBuildCompleteCallback`
 * carries the same data already parsed. `provider` values come from the
 * control plane's provider union (deploy configuration, not part of this
 * contract).
 */
export interface ImageBuildRecordView {
  id: string;
  scope_kind: ImageBuildScopeKind;
  scope_id: string;
  provider: string;
  status: ImageBuildStatus;
  repositories_fingerprint: string;
  repository_shas: string;
  runtime_version: string;
  build_duration_seconds: number | null;
  error_message: string | null;
  created_at: number;
}

/**
 * Success callback POSTed by the Modal build worker
 * (`image_builder.py`) to `/image-builds/build-complete`.
 *
 * `repository_shas` arrives as a parsed array here and is stored
 * JSON-encoded (see `ImageBuildRecordView.repository_shas`).
 */
export interface ImageBuildCompleteCallback {
  build_id: string;
  provider_image_id: string;
  repository_shas: RepositoryShaEntry[];
  runtime_version: string;
  build_duration_seconds: number;
}

/**
 * Failure callback POSTed by the Modal build worker
 * (`image_builder.py`) to `/image-builds/build-failed`.
 */
export interface ImageBuildFailedCallback {
  build_id: string;
  error: string;
}
