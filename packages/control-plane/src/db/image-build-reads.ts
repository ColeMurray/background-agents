import type {
  ImageBuildRecordView,
  ImageBuildScopeKind,
  ImageBuildStatus,
} from "@open-inspect/shared/types/image-builds";
import type { SandboxExecutionProfile } from "@open-inspect/shared/types/sandbox-execution";
import type { ImageBuildScope } from "../image-builds/model";
import { parseRepositoryShasJson } from "../image-builds/provenance";
import type { SqlDatabase } from "./sql-database";

/** D1 caps bound parameters per statement; IN-list queries chunk below it. */
const MAX_SCOPE_IDS_PER_QUERY = 50;

interface ImageBuildStatusRow {
  id: string;
  scope_kind: ImageBuildScopeKind;
  scope_id: string;
  provider: ImageBuildRecordView["provider"];
  execution_profile: SandboxExecutionProfile;
  status: ImageBuildStatus;
  repositories_fingerprint: string;
  repository_shas: string;
  runtime_version: string;
  build_duration_seconds: number | null;
  error_message: string | null;
  created_at: number;
}

/** Exact public-safe storage projection; internal provider/token columns stay private. */
const STATUS_VIEW_KEYS = [
  "id",
  "scope_kind",
  "scope_id",
  "provider",
  "execution_profile",
  "status",
  "repositories_fingerprint",
  "repository_shas",
  "runtime_version",
  "build_duration_seconds",
  "error_message",
  "created_at",
] as const satisfies readonly (keyof ImageBuildStatusRow)[];

type MissingStatusViewKey = Exclude<keyof ImageBuildStatusRow, (typeof STATUS_VIEW_KEYS)[number]>;
const _statusViewComplete: MissingStatusViewKey extends never ? true : MissingStatusViewKey = true;
void _statusViewComplete;

const STATUS_VIEW_COLUMNS = STATUS_VIEW_KEYS.join(", ");

function toView(row: ImageBuildStatusRow): ImageBuildRecordView {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    provider: row.provider,
    executionProfile: row.execution_profile,
    status: row.status,
    repositoriesFingerprint: row.repositories_fingerprint,
    repositoryShas: parseRepositoryShasJson(row.repository_shas),
    runtimeVersion: row.runtime_version,
    buildDurationSeconds: row.build_duration_seconds,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export async function getImageBuildStatus(
  db: SqlDatabase,
  scope: ImageBuildScope
): Promise<ImageBuildRecordView[]> {
  const result = await db
    .prepare(
      `SELECT ${STATUS_VIEW_COLUMNS} FROM image_builds WHERE scope_kind = ? AND scope_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 10`
    )
    .bind(scope.kind, scope.id)
    .all<ImageBuildStatusRow>();
  return (result.results || []).map(toView);
}

export async function getImageBuildReconciliationStatus(
  db: SqlDatabase,
  scope: ImageBuildScope,
  provider: ImageBuildRecordView["provider"],
  executionProfile: SandboxExecutionProfile
): Promise<ImageBuildRecordView[]> {
  const result = await db
    .prepare(
      `SELECT ${STATUS_VIEW_COLUMNS} FROM image_builds
       WHERE scope_kind = ? AND scope_id = ? AND provider = ?
         AND (status = 'building' OR (status = 'ready' AND execution_profile = ?))
       ORDER BY created_at DESC`
    )
    .bind(scope.kind, scope.id, provider, executionProfile)
    .all<ImageBuildStatusRow>();
  return (result.results || []).map(toView);
}

export async function getImageBuildStatusForEnabledScopes(
  db: SqlDatabase,
  scopes: ImageBuildScope[]
): Promise<ImageBuildRecordView[]> {
  const idsByKind = new Map<ImageBuildScopeKind, string[]>();
  for (const scope of scopes) {
    const ids = idsByKind.get(scope.kind) ?? [];
    ids.push(scope.id);
    idsByKind.set(scope.kind, ids);
  }

  const rows: ImageBuildRecordView[] = [];
  for (const [kind, ids] of idsByKind) {
    for (let offset = 0; offset < ids.length; offset += MAX_SCOPE_IDS_PER_QUERY) {
      const chunk = ids.slice(offset, offset + MAX_SCOPE_IDS_PER_QUERY);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT ${STATUS_VIEW_COLUMNS} FROM image_builds
           WHERE scope_kind = ? AND scope_id IN (${placeholders}) AND status <> 'superseded'`
        )
        .bind(kind, ...chunk)
        .all<ImageBuildStatusRow>();
      rows.push(...(result.results || []).map(toView));
    }
  }
  rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  return rows;
}
