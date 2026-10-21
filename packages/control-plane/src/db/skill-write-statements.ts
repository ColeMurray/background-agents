import {
  skillImportSourceSchema,
  type SkillAssignmentInput,
  type SkillContentInput,
  type SkillFile,
  type SkillImportSource,
} from "@open-inspect/shared/types/skills";
import { generateId } from "../auth/crypto";
import type { buildValidatedSkillRevision } from "../skills/content-addressing";
import { bulkInsertStatements } from "./bulk-insert";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

type BuiltRevision = Awaited<ReturnType<typeof buildValidatedSkillRevision>>;

export interface ImportedSkillCreateInput {
  name: string;
  content: SkillContentInput;
  source: SkillImportSource;
}

interface ImportedSkillWrite {
  input: ImportedSkillCreateInput;
  id: string;
  revisionId: string;
  revision: BuiltRevision;
}

// These row serializers own persisted fields for both packed imports and guarded edits.
function catalogRow(id: string, name: string, actorUserId: string, now: number) {
  return {
    id,
    name,
    current_revision_id: null,
    enabled: 1,
    deleted_at: null,
    created_by: actorUserId,
    updated_by: actorUserId,
    created_at: now,
    updated_at: now,
  };
}

function revisionRow(
  revisionId: string,
  skillId: string,
  revisionNumber: number,
  content: SkillContentInput,
  revision: BuiltRevision,
  actorUserId: string,
  now: number
) {
  return {
    id: revisionId,
    skill_id: skillId,
    revision_number: revisionNumber,
    revision_sha256: revision.revisionSha256,
    description: content.description,
    body: content.body,
    license: content.license ?? null,
    compatibility: content.compatibility ?? null,
    metadata_json: JSON.stringify(content.metadata),
    total_bytes: revision.totalBytes,
    created_by: actorUserId,
    created_at: now,
  };
}

function fileRow(revisionId: string, file: SkillFile) {
  return {
    revision_id: revisionId,
    path: file.path,
    content: file.content,
    content_sha256: file.sha256,
    size_bytes: file.sizeBytes,
    executable: file.executable ? 1 : 0,
  };
}

function assignmentRow(
  skillId: string,
  assignment: SkillAssignmentInput,
  actorUserId: string,
  now: number
) {
  return {
    id: `skillassign_${generateId()}`,
    skill_id: skillId,
    scope_type: assignment.type,
    repo_owner: assignment.type === "repository" ? assignment.repository.repoOwner : null,
    repo_name: assignment.type === "repository" ? assignment.repository.repoName : null,
    environment_id: assignment.type === "environment" ? assignment.environmentId : null,
    created_by: actorUserId,
    created_at: now,
  };
}

function sourceRow(revisionId: string, skillId: string, input: SkillImportSource, now: number) {
  const source = skillImportSourceSchema.parse(input);
  return {
    revision_id: revisionId,
    skill_id: skillId,
    provider: source.provider,
    repo_owner: source.repoOwner,
    repo_name: source.repoName,
    requested_ref: source.requestedRef,
    resolved_ref: source.resolvedRef,
    commit_sha: source.commitSha,
    subdirectory: source.subdirectory,
    source_sha256: source.sourceSha256,
    imported_at: now,
  };
}

/** Table, columns and predicate are internal SQL; only values can come from request data. */
function insertWhere(
  db: SqlDatabase,
  table: string,
  row: Record<string, unknown>,
  predicate: string,
  values: unknown[]
): SqlStatement {
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")})
    SELECT ${columns.map(() => "?").join(", ")} WHERE ${predicate}`
    )
    .bind(...Object.values(row), ...values);
}

export function catalogInsert(
  db: SqlDatabase,
  id: string,
  name: string,
  actorUserId: string,
  now: number
): SqlStatement {
  return bulkInsertStatements(db, "skills", [catalogRow(id, name, actorUserId, now)])[0];
}

export function revisionInsert(
  db: SqlDatabase,
  revisionId: string,
  skillId: string,
  revisionNumber: number,
  content: SkillContentInput,
  revision: BuiltRevision,
  actorUserId: string,
  now: number,
  expectedCurrentRevisionId: string | null = null
): SqlStatement {
  return insertWhere(
    db,
    "skill_revisions",
    revisionRow(revisionId, skillId, revisionNumber, content, revision, actorUserId, now),
    `? IS NULL OR EXISTS (
      SELECT 1 FROM skills WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL
    )`,
    [expectedCurrentRevisionId, skillId, expectedCurrentRevisionId]
  );
}

export function fileInserts(
  db: SqlDatabase,
  revisionId: string,
  files: SkillFile[]
): SqlStatement[] {
  return files.map((file) =>
    insertWhere(
      db,
      "skill_revision_files",
      fileRow(revisionId, file),
      "EXISTS (SELECT 1 FROM skill_revisions WHERE id = ?)",
      [revisionId]
    )
  );
}

export function assignmentInserts(
  db: SqlDatabase,
  skillId: string,
  assignments: SkillAssignmentInput[],
  actorUserId: string,
  now: number,
  requiredCurrentRevisionId?: string
): SqlStatement[] {
  return assignments.map((assignment) =>
    insertWhere(
      db,
      "skill_assignments",
      assignmentRow(skillId, assignment, actorUserId, now),
      `? IS NULL OR EXISTS (
      SELECT 1 FROM skills WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL
    )`,
      [requiredCurrentRevisionId ?? null, skillId, requiredCurrentRevisionId ?? null]
    )
  );
}

export function importSourceInsert(
  db: SqlDatabase,
  revisionId: string,
  skillId: string,
  source: SkillImportSource,
  now: number
): SqlStatement {
  return insertWhere(
    db,
    "skill_import_sources",
    sourceRow(revisionId, skillId, source, now),
    "EXISTS (SELECT 1 FROM skill_revisions WHERE id = ? AND skill_id = ?)",
    [revisionId, skillId]
  );
}

/** Build packed writes; the caller adds catalog invalidation and submits one atomic batch. */
export function importedSkillStatements(
  db: SqlDatabase,
  records: ImportedSkillWrite[],
  assignments: SkillAssignmentInput[],
  actorUserId: string,
  now: number
): SqlStatement[] {
  return [
    ...bulkInsertStatements(
      db,
      "skills",
      records.map((record) => catalogRow(record.id, record.input.name, actorUserId, now))
    ),
    ...bulkInsertStatements(
      db,
      "skill_revisions",
      records.map((record) =>
        revisionRow(
          record.revisionId,
          record.id,
          1,
          record.input.content,
          record.revision,
          actorUserId,
          now
        )
      )
    ),
    ...bulkInsertStatements(
      db,
      "skill_revision_files",
      records.flatMap((record) =>
        record.revision.files.map((file) => fileRow(record.revisionId, file))
      )
    ),
    ...currentRevisionUpdates(db, records),
    ...bulkInsertStatements(
      db,
      "skill_assignments",
      records.flatMap((record) =>
        assignments.map((assignment) => assignmentRow(record.id, assignment, actorUserId, now))
      )
    ),
    ...bulkInsertStatements(
      db,
      "skill_import_sources",
      records.map((record) => sourceRow(record.revisionId, record.id, record.input.source, now))
    ),
  ];
}

function currentRevisionUpdates(
  db: SqlDatabase,
  records: { id: string; revisionId: string }[]
): SqlStatement[] {
  const recordsPerStatement = Math.floor(MAX_D1_QUERY_PARAMETERS / 3);
  const statements: SqlStatement[] = [];
  for (let start = 0; start < records.length; start += recordsPerStatement) {
    const chunk = records.slice(start, start + recordsPerStatement);
    const cases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const placeholders = chunk.map(() => "?").join(", ");
    statements.push(
      db
        .prepare(
          `UPDATE skills SET current_revision_id = CASE id ${cases} END
      WHERE id IN (${placeholders})`
        )
        .bind(
          ...chunk.flatMap((record) => [record.id, record.revisionId]),
          ...chunk.map((record) => record.id)
        )
    );
  }
  return statements;
}
