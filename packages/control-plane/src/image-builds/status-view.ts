import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import type { ImageBuildStatusRow } from "../db/image-builds";
import { parseRepositoryShasJson } from "./provenance";

export function toImageBuildRecordView(row: ImageBuildStatusRow): ImageBuildRecordView {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    provider: row.provider,
    status: row.status,
    repositoriesFingerprint: row.repositories_fingerprint,
    repositoryShas: parseRepositoryShasJson(row.repository_shas),
    runtimeVersion: row.runtime_version,
    buildDurationSeconds: row.build_duration_seconds,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}
