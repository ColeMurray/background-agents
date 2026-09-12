import {
  skillImportProvenanceSchema,
  skillImportSourceSchema,
  skillMetadataSchema,
  type CreateSkillInput,
  type ReplaceSkillContentAndAssignmentsInput,
  type SetSkillEnabledInput,
  type Skill,
  type SkillAssignment,
  type SkillAssignmentInput,
  type SkillContentInput,
  type SkillFile,
  type SkillImportProvenance,
  type SkillImportSource,
  type SkillSummary,
} from "@open-inspect/shared/types/skills";
import { generateId } from "../auth/crypto";
import { buildValidatedSkillRevision } from "../skills/content-addressing";
import { isUniqueConstraintError } from "./errors";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

const RESERVED_SKILL_NAMES = new Set([
  "agent-browser",
  "record-video",
  "upload-screenshot",
  "visual-verification",
  "customize-opencode",
]);

interface SkillRow {
  id: string;
  name: string;
  current_revision_id: string;
  enabled: number;
  deleted_at: number | null;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
  revision_number: number;
  revision_sha256: string;
  description: string;
  body: string;
  license: string | null;
  compatibility: string | null;
  metadata_json: string;
  total_bytes: number;
  revision_created_by: string;
  creator_display_name: string | null;
  last_editor_display_name: string | null;
  revision_author_display_name: string | null;
}

interface AssignmentRow {
  id: string;
  skill_id: string;
  scope_type: "global" | "repository" | "environment";
  repo_owner: string | null;
  repo_name: string | null;
  environment_id: string | null;
  environment_name: string | null;
}

interface FileRow {
  path: string;
  content: string;
  content_sha256: string;
  size_bytes: number;
  executable: number;
}

interface ImportSourceRow {
  revision_id: string;
  skill_id: string;
  provider: string;
  repo_owner: string;
  repo_name: string;
  requested_ref: string | null;
  resolved_ref: string;
  commit_sha: string;
  subdirectory: string | null;
  source_sha256: string;
  imported_at: number;
}

interface CurrentSkillRevisionRow {
  name: string;
  current_revision_id: string;
  revision_number: number;
  revision_sha256: string;
}

export class SkillConflictError extends Error {}
export class SkillValidationError extends Error {}
interface ApplicableSkill {
  id: string;
  name: string;
  description: string;
  currentRevisionId: string;
  revisionNumber: number;
  revisionSha256: string;
  assignments: SkillAssignment[];
  totalBytes: number;
}

interface SkillListResult {
  skills: SkillSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Mutable catalog operations backed by immutable content revisions. */
export class SkillStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(options: { limit: number; cursor: string | null }): Promise<SkillListResult> {
    const result = await this.db
      .prepare(
        `${this.currentSkillSelect()}
         WHERE s.deleted_at IS NULL
           ${options.cursor ? "AND s.name > ?" : ""}
         ORDER BY s.name
         LIMIT ?`
      )
      .bind(...(options.cursor ? [options.cursor] : []), options.limit + 1)
      .all<SkillRow>();
    const fetchedRows = result.results ?? [];
    const hasMore = fetchedRows.length > options.limit;
    const rows = hasMore ? fetchedRows.slice(0, options.limit) : fetchedRows;
    const ids = rows.map((row) => row.id);
    const [assignments, sources] = await Promise.all([
      this.assignmentsForSkills(ids),
      this.sourcesForSkills(ids),
    ]);
    const skills = rows.map((row) =>
      this.toSummary(row, assignments.get(row.id) ?? [], sources.get(row.id) ?? null)
    );
    return {
      skills,
      hasMore,
      nextCursor: hasMore ? rows[rows.length - 1].name : null,
    };
  }

  async get(id: string): Promise<Skill | null> {
    const row = await this.db
      .prepare(
        `${this.currentSkillSelect()}
         WHERE s.id = ? AND s.deleted_at IS NULL`
      )
      .bind(id)
      .first<SkillRow>();
    if (!row) return null;
    const [assignments, source, files] = await Promise.all([
      this.assignmentsForSkill(row.id),
      this.latestImportSource(row.id),
      this.filesForRevision(row.current_revision_id),
    ]);
    return {
      ...this.toSummary(row, assignments, source),
      body: row.body,
      license: row.license,
      compatibility: row.compatibility,
      metadata: skillMetadataSchema.parse(JSON.parse(row.metadata_json)),
      files,
    };
  }

  /**
   * @param source - Provenance to record when the content came from a
   *   repository import; omitted for editor-authored skills.
   */
  async create(
    input: CreateSkillInput,
    actorUserId: string,
    source?: SkillImportSource
  ): Promise<Skill> {
    if (RESERVED_SKILL_NAMES.has(input.name)) {
      throw new SkillConflictError("Skill name is reserved by the sandbox runtime");
    }
    const existing = await this.db
      .prepare("SELECT id FROM skills WHERE lower(name) = lower(?)")
      .bind(input.name)
      .first<{ id: string }>();
    if (existing) throw new SkillConflictError("A skill with this name already exists");

    await this.validateAssignments(input.assignments);
    const revision = await buildValidatedSkillRevision(input.name, input.content);
    const id = `skill_${generateId()}`;
    const revisionId = `skillrev_${generateId()}`;
    const now = Date.now();
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO skills
             (id, name, current_revision_id, enabled, deleted_at, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, NULL, 1, NULL, ?, ?, ?, ?)`
          )
          .bind(id, input.name, actorUserId, actorUserId, now, now),
        this.revisionInsert(revisionId, id, 1, input.content, revision, actorUserId, now),
        ...this.fileInserts(revisionId, revision.files),
        this.db
          .prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?")
          .bind(revisionId, id),
        ...this.assignmentInserts(id, input.assignments, actorUserId, now),
        ...(source ? [this.importSourceInsert(revisionId, id, source, now)] : []),
        this.bumpGeneration(),
      ]);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const conflicting = await this.db
          .prepare("SELECT id FROM skills WHERE lower(name) = lower(?)")
          .bind(input.name)
          .first<{ id: string }>();
        if (conflicting) throw new SkillConflictError("A skill with this name already exists");
      }
      throw error;
    }
    return (await this.get(id))!;
  }

  async setEnabled(
    id: string,
    input: SetSkillEnabledInput,
    actorUserId: string
  ): Promise<Skill | null> {
    const current = await this.get(id);
    if (!current) return null;
    const now = Date.now();
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE skills SET enabled = ?, updated_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
        )
        .bind(input.enabled ? 1 : 0, actorUserId, now, id),
      this.bumpGeneration(),
    ]);
    return this.get(id);
  }

  /**
   * Atomically replace content and assignments under one revision precondition.
   * Every statement is guarded so a stale editor cannot partially mutate scope.
   */
  async replaceContentAndAssignments(
    id: string,
    input: ReplaceSkillContentAndAssignmentsInput,
    actorUserId: string,
    expectedRevisionId: string
  ): Promise<Skill | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (expectedRevisionId !== current.currentRevisionId) {
      throw new SkillConflictError(`Current revision is ${current.currentRevisionId}`);
    }
    await this.validateAssignments(input.assignments);
    const revision = await buildValidatedSkillRevision(current.name, input.content);
    const now = Date.now();
    const statements: SqlStatement[] = [];
    let updateResultIndex: number;
    let resultingRevisionId = expectedRevisionId;

    if (revision.revisionSha256 === current.revisionSha256) {
      updateResultIndex = statements.length;
      statements.push(
        this.db
          .prepare(
            `UPDATE skills SET updated_by = ?, updated_at = ?
             WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL`
          )
          .bind(actorUserId, now, id, expectedRevisionId)
      );
    } else {
      const revisionId = `skillrev_${generateId()}`;
      resultingRevisionId = revisionId;
      statements.push(
        this.revisionInsert(
          revisionId,
          id,
          current.revisionNumber + 1,
          input.content,
          revision,
          actorUserId,
          now,
          expectedRevisionId
        ),
        ...this.fileInserts(revisionId, revision.files)
      );
      updateResultIndex = statements.length;
      statements.push(
        this.db
          .prepare(
            `UPDATE skills SET current_revision_id = ?, updated_by = ?, updated_at = ?
             WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL`
          )
          .bind(revisionId, actorUserId, now, id, expectedRevisionId)
      );
    }
    statements.push(
      this.db
        .prepare(
          `DELETE FROM skill_assignments WHERE skill_id = ?
           AND EXISTS (
             SELECT 1 FROM skills WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL
           )`
        )
        .bind(id, id, resultingRevisionId),
      ...this.assignmentInserts(id, input.assignments, actorUserId, now, resultingRevisionId),
      this.bumpGeneration(id, resultingRevisionId)
    );
    let results: Awaited<ReturnType<SqlDatabase["batch"]>>;
    try {
      results = await this.db.batch(statements);
    } catch (error) {
      const latest = await this.get(id);
      if (latest && latest.currentRevisionId !== expectedRevisionId) {
        throw new SkillConflictError("Skill changed concurrently");
      }
      throw error;
    }
    if ((results[updateResultIndex]?.meta.changes ?? 0) === 0) {
      throw new SkillConflictError("Skill changed concurrently");
    }
    return this.get(id);
  }

  /**
   * Add a revision carrying re-imported content, leaving assignments alone.
   *
   * Byte-identical content is a no-op: no revision, no new provenance row, and
   * `revisionCreated` false. The recorded source keeps pointing at the commit
   * that produced the stored bytes, which is still where they came from.
   */
  async applyImportedRevision(
    id: string,
    content: SkillContentInput,
    source: SkillImportSource,
    actorUserId: string,
    expectedRevisionId: string
  ): Promise<{ skill: Skill; revisionCreated: boolean } | null> {
    const current = await this.currentRevision(id);
    if (!current) return null;
    if (expectedRevisionId !== current.current_revision_id) {
      throw new SkillConflictError(`Current revision is ${current.current_revision_id}`);
    }
    const revision = await buildValidatedSkillRevision(current.name, content);
    if (revision.revisionSha256 === current.revision_sha256) {
      const skill = await this.get(id);
      if (!skill) return null;
      if (skill.currentRevisionId !== expectedRevisionId) {
        throw new SkillConflictError("Skill changed concurrently");
      }
      return { skill, revisionCreated: false };
    }
    const now = Date.now();
    const revisionId = `skillrev_${generateId()}`;
    const statements: SqlStatement[] = [
      this.revisionInsert(
        revisionId,
        id,
        current.revision_number + 1,
        content,
        revision,
        actorUserId,
        now,
        expectedRevisionId
      ),
      ...this.fileInserts(revisionId, revision.files),
    ];
    const updateResultIndex = statements.length;
    statements.push(
      this.db
        .prepare(
          `UPDATE skills SET current_revision_id = ?, updated_by = ?, updated_at = ?
           WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL`
        )
        .bind(revisionId, actorUserId, now, id, expectedRevisionId),
      this.importSourceInsert(revisionId, id, source, now),
      this.bumpGeneration(id, revisionId)
    );
    let results: Awaited<ReturnType<SqlDatabase["batch"]>>;
    try {
      results = await this.db.batch(statements);
    } catch (error) {
      const latest = await this.get(id);
      if (latest && latest.currentRevisionId !== expectedRevisionId) {
        throw new SkillConflictError("Skill changed concurrently");
      }
      throw error;
    }
    if ((results[updateResultIndex]?.meta.changes ?? 0) === 0) {
      throw new SkillConflictError("Skill changed concurrently");
    }
    return { skill: (await this.get(id))!, revisionCreated: true };
  }

  async delete(id: string, actorUserId: string): Promise<boolean> {
    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE skills SET deleted_at = ?, enabled = 0, updated_by = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        )
        .bind(now, actorUserId, now, id),
      this.bumpGeneration(),
    ]);
    return (results[0]?.meta.changes ?? 0) > 0;
  }

  /**
   * Whether a canonical name can still be claimed. Matches what `create`
   * enforces: reserved names and names held by deleted skills stay taken.
   */
  async nameAvailable(name: string): Promise<boolean> {
    if (RESERVED_SKILL_NAMES.has(name)) return false;
    const existing = await this.db
      .prepare("SELECT id FROM skills WHERE lower(name) = lower(?)")
      .bind(name)
      .first<{ id: string }>();
    return existing === null;
  }

  /**
   * Return the catalog's monotonic invalidation token. Consumers compare only
   * for equality; the value is not a count of logical catalog revisions.
   */
  async catalogGeneration(): Promise<number> {
    const row = await this.db
      .prepare("SELECT generation FROM skills_catalog_state WHERE singleton = 1")
      .first<{ generation: number }>();
    if (!row) throw new Error("Managed skills catalog state is missing");
    return row.generation;
  }

  /** Return enabled skills with only the assignments matching this session target. */
  async listApplicable(input: {
    repositories: readonly { repoOwner: string; repoName: string }[];
    environmentId: string | null;
  }): Promise<ApplicableSkill[]> {
    const repositoryConditions = input.repositories.map(
      () =>
        "(a.scope_type = 'repository' AND lower(a.repo_owner) = lower(?) AND lower(a.repo_name) = lower(?))"
    );
    const assignmentConditions = [
      "a.scope_type = 'global'",
      ...(input.environmentId === null
        ? []
        : ["(a.scope_type = 'environment' AND a.environment_id = ?)"]),
      ...repositoryConditions,
    ];
    const assignmentParams = [
      ...(input.environmentId === null ? [] : [input.environmentId]),
      ...input.repositories.flatMap(({ repoOwner, repoName }) => [repoOwner, repoName]),
    ];
    const rows = await this.db
      .prepare(
        `${this.currentSkillSelect()}
         WHERE s.enabled = 1 AND s.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM skill_assignments a
             WHERE a.skill_id = s.id AND (${assignmentConditions.join(" OR ")})
           )
         ORDER BY s.name`
      )
      .bind(...assignmentParams)
      .all<SkillRow>();
    const repositoryKeys = new Set(
      input.repositories.map(
        (repository) =>
          `${repository.repoOwner.toLowerCase()}\0${repository.repoName.toLowerCase()}`
      )
    );
    const applicableIds = (rows.results ?? []).map((row) => row.id);
    const assignmentsBySkill = await this.assignmentsForSkills(applicableIds);
    const applicable: ApplicableSkill[] = [];
    for (const row of rows.results ?? []) {
      const assignments = assignmentsBySkill.get(row.id) ?? [];
      const matching = assignments.filter((assignment) => {
        if (assignment.type === "global") return true;
        if (assignment.type === "environment") {
          return input.environmentId !== null && assignment.environmentId === input.environmentId;
        }
        return repositoryKeys.has(
          `${assignment.repoOwner.toLowerCase()}\0${assignment.repoName.toLowerCase()}`
        );
      });
      if (matching.length === 0) continue;
      applicable.push({
        id: row.id,
        name: row.name,
        description: row.description,
        currentRevisionId: row.current_revision_id,
        revisionNumber: row.revision_number,
        revisionSha256: row.revision_sha256,
        assignments: matching,
        totalBytes: row.total_bytes,
      });
    }
    return applicable;
  }

  async filesForRevision(revisionId: string): Promise<SkillFile[]> {
    const result = await this.db
      .prepare(
        `SELECT path, content, content_sha256, size_bytes, executable
         FROM skill_revision_files WHERE revision_id = ?
         ORDER BY path`
      )
      .bind(revisionId)
      .all<FileRow>();
    return (result.results ?? []).map((row) => this.toFile(row));
  }

  /**
   * Load installation files for the revisions a session pinned, optionally
   * narrowed to one page of manifest positions.
   *
   * Keyed by session rather than by a revision-ID list on purpose: the IDs
   * already live in `session_skill_revisions`, so passing them back as bound
   * parameters would cap the manifest at the engine's parameter ceiling for no
   * gain. Narrowing by position keeps that property — three parameters whether
   * the page holds one revision or a thousand.
   */
  async filesForSessionRevisions(
    sessionId: string,
    page?: { after: number; limit: number }
  ): Promise<Map<string, SkillFile[]>> {
    const pinnedRevisions = page
      ? `SELECT revision_id FROM session_skill_revisions
         WHERE session_id = ? AND position > ? ORDER BY position LIMIT ?`
      : "SELECT revision_id FROM session_skill_revisions WHERE session_id = ?";
    const result = await this.db
      .prepare(
        `SELECT f.revision_id, f.path, f.content, f.content_sha256, f.size_bytes, f.executable
         FROM skill_revision_files f
         WHERE f.revision_id IN (${pinnedRevisions})
         ORDER BY f.revision_id, f.path`
      )
      .bind(...(page ? [sessionId, page.after, page.limit] : [sessionId]))
      .all<FileRow & { revision_id: string }>();
    const files = new Map<string, SkillFile[]>();
    for (const row of result.results ?? []) {
      const existing = files.get(row.revision_id);
      const file = this.toFile(row);
      if (existing) existing.push(file);
      else files.set(row.revision_id, [file]);
    }
    return files;
  }

  private toFile(row: FileRow): SkillFile {
    return {
      path: row.path,
      content: row.content,
      sha256: row.content_sha256,
      sizeBytes: row.size_bytes,
      executable: row.executable === 1,
    };
  }

  private currentSkillSelect(): string {
    return `SELECT s.*, r.revision_number, r.revision_sha256, r.description, r.body,
       r.license, r.compatibility, r.metadata_json, r.total_bytes,
       r.created_by AS revision_created_by,
       creator.display_name AS creator_display_name,
       editor.display_name AS last_editor_display_name,
       revision_author.display_name AS revision_author_display_name
             FROM skills s
            JOIN skill_revisions r ON r.id = s.current_revision_id AND r.skill_id = s.id
            LEFT JOIN users creator ON creator.id = s.created_by
            LEFT JOIN users editor ON editor.id = s.updated_by
            LEFT JOIN users revision_author ON revision_author.id = r.created_by`;
  }

  private toSummary(
    row: SkillRow,
    assignments: SkillAssignment[],
    source: SkillImportProvenance | null
  ): SkillSummary {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      currentRevisionId: row.current_revision_id,
      revisionNumber: row.revision_number,
      revisionSha256: row.revision_sha256,
      revisionCreatedBy: row.revision_created_by,
      creatorDisplayName: row.creator_display_name,
      lastEditorDisplayName: row.last_editor_display_name,
      revisionAuthorDisplayName: row.revision_author_display_name,
      assignments,
      source,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * The skill's most recent import, or null when it was authored in the editor.
   * Reported from the newest import rather than the current revision so a hand
   * edit after an import does not erase where the skill came from.
   */
  async latestImportSource(skillId: string): Promise<SkillImportProvenance | null> {
    return (await this.sourcesForSkills([skillId])).get(skillId) ?? null;
  }

  private async sourcesForSkills(
    skillIds: string[]
  ): Promise<Map<string, SkillImportProvenance | null>> {
    const sources = new Map<string, SkillImportProvenance | null>();
    for (const skillId of skillIds) sources.set(skillId, null);
    if (skillIds.length === 0) return sources;
    // Chunked for the same reason as assignmentsForSkills: a target can match
    // more skills than D1 accepts bound parameters in one statement.
    const rows: ImportSourceRow[] = [];
    for (let start = 0; start < skillIds.length; start += MAX_D1_QUERY_PARAMETERS) {
      const chunk = skillIds.slice(start, start + MAX_D1_QUERY_PARAMETERS);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await this.db
        .prepare(
          `SELECT source.*
           FROM skills skill
           JOIN skill_import_sources source ON source.rowid = (
             SELECT latest.rowid
             FROM skill_import_sources latest
             WHERE latest.skill_id = skill.id
             ORDER BY latest.imported_at DESC, latest.rowid DESC
             LIMIT 1
           )
           WHERE skill.id IN (${placeholders})`
        )
        .bind(...chunk)
        .all<ImportSourceRow>();
      rows.push(...(result.results ?? []));
    }
    for (const row of rows) {
      sources.set(
        row.skill_id,
        skillImportProvenanceSchema.parse({
          provider: row.provider,
          repoOwner: row.repo_owner,
          repoName: row.repo_name,
          requestedRef: row.requested_ref,
          resolvedRef: row.resolved_ref,
          commitSha: row.commit_sha,
          subdirectory: row.subdirectory,
          sourceSha256: row.source_sha256,
          importedAt: row.imported_at,
          revisionId: row.revision_id,
        })
      );
    }
    return sources;
  }

  /** Load only the mutable revision state needed for a re-import CAS decision. */
  private async currentRevision(id: string): Promise<CurrentSkillRevisionRow | null> {
    return this.db
      .prepare(
        `SELECT s.name, s.current_revision_id, r.revision_number, r.revision_sha256
         FROM skills s
         JOIN skill_revisions r ON r.id = s.current_revision_id AND r.skill_id = s.id
         WHERE s.id = ? AND s.deleted_at IS NULL`
      )
      .bind(id)
      .first<CurrentSkillRevisionRow>();
  }

  /** Record where a revision's content was imported from. */
  private importSourceInsert(
    revisionId: string,
    skillId: string,
    source: SkillImportSource,
    now: number
  ): SqlStatement {
    const validatedSource = skillImportSourceSchema.parse(source);
    return this.db
      .prepare(
        `INSERT INTO skill_import_sources
          (revision_id, skill_id, provider, repo_owner, repo_name, requested_ref,
           resolved_ref, commit_sha, subdirectory, source_sha256, imported_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM skill_revisions WHERE id = ? AND skill_id = ?)`
      )
      .bind(
        revisionId,
        skillId,
        validatedSource.provider,
        validatedSource.repoOwner,
        validatedSource.repoName,
        validatedSource.requestedRef,
        validatedSource.resolvedRef,
        validatedSource.commitSha,
        validatedSource.subdirectory,
        validatedSource.sourceSha256,
        now,
        revisionId,
        skillId
      );
  }

  private async assignmentsForSkill(skillId: string): Promise<SkillAssignment[]> {
    return (await this.assignmentsForSkills([skillId])).get(skillId) ?? [];
  }

  private async assignmentsForSkills(skillIds: string[]): Promise<Map<string, SkillAssignment[]>> {
    const assignments = new Map<string, SkillAssignment[]>();
    for (const skillId of skillIds) assignments.set(skillId, []);
    if (skillIds.length === 0) return assignments;
    const rows: AssignmentRow[] = [];
    for (let start = 0; start < skillIds.length; start += MAX_D1_QUERY_PARAMETERS) {
      const chunk = skillIds.slice(start, start + MAX_D1_QUERY_PARAMETERS);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await this.db
        .prepare(
          `SELECT a.*, e.name AS environment_name
           FROM skill_assignments a
           LEFT JOIN environments e ON e.id = a.environment_id
           WHERE a.skill_id IN (${placeholders})
           ORDER BY a.skill_id, a.scope_type, a.id`
        )
        .bind(...chunk)
        .all<AssignmentRow>();
      rows.push(...(result.results ?? []));
    }
    for (const row of rows) {
      let assignment: SkillAssignment;
      if (row.scope_type === "repository") {
        assignment = {
          id: row.id,
          type: "repository",
          repoOwner: row.repo_owner!,
          repoName: row.repo_name!,
        };
      } else if (row.scope_type === "environment") {
        assignment = {
          id: row.id,
          type: "environment",
          environmentId: row.environment_id!,
        };
        if (row.environment_name) assignment.environmentName = row.environment_name;
      } else {
        assignment = { id: row.id, type: "global" };
      }
      assignments.get(row.skill_id)?.push(assignment);
    }
    return assignments;
  }

  private async validateAssignments(assignments: SkillAssignmentInput[]): Promise<void> {
    const keys = assignments.map((assignment) => {
      if (assignment.type === "global") return "global";
      if (assignment.type === "environment") return `environment:${assignment.environmentId}`;
      return `repository:${assignment.repository.repoOwner.toLowerCase()}/${assignment.repository.repoName.toLowerCase()}`;
    });
    if (new Set(keys).size !== keys.length) {
      throw new SkillValidationError("Skill assignments must be unique");
    }
    const environmentIds = [
      ...new Set(
        assignments.flatMap((assignment) =>
          assignment.type === "environment" ? [assignment.environmentId] : []
        )
      ),
    ];
    if (environmentIds.length === 0) return;
    // `assignments` is request input and carries no length bound, so this
    // cannot bind a parameter per environment: past the engine ceiling it
    // fails outright with `too many SQL variables` instead of reporting a
    // validation error, which made a skill assigned to more than
    // MAX_D1_QUERY_PARAMETERS environments impossible to create.
    let found = 0;
    for (let start = 0; start < environmentIds.length; start += MAX_D1_QUERY_PARAMETERS) {
      const chunk = environmentIds.slice(start, start + MAX_D1_QUERY_PARAMETERS);
      const placeholders = chunk.map(() => "?").join(", ");
      const row = await this.db
        .prepare(`SELECT COUNT(*) AS count FROM environments WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .first<{ count: number }>();
      found += row?.count ?? 0;
    }
    if (found !== environmentIds.length) {
      throw new SkillValidationError("One or more assigned environments do not exist");
    }
  }

  private revisionInsert(
    revisionId: string,
    skillId: string,
    revisionNumber: number,
    content: SkillContentInput,
    revision: Awaited<ReturnType<typeof buildValidatedSkillRevision>>,
    actorUserId: string,
    now: number,
    expectedCurrentRevisionId: string | null = null
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO skill_revisions
         (id, skill_id, revision_number, revision_sha256, description, body, license,
          compatibility, metadata_json, total_bytes, created_by, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ? IS NULL OR EXISTS (
            SELECT 1 FROM skills
            WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL
          )`
      )
      .bind(
        revisionId,
        skillId,
        revisionNumber,
        revision.revisionSha256,
        content.description,
        content.body,
        content.license ?? null,
        content.compatibility ?? null,
        JSON.stringify(content.metadata),
        revision.totalBytes,
        actorUserId,
        now,
        expectedCurrentRevisionId,
        skillId,
        expectedCurrentRevisionId
      );
  }

  private fileInserts(revisionId: string, files: SkillFile[]): SqlStatement[] {
    return files.map((file) =>
      this.db
        .prepare(
          `INSERT INTO skill_revision_files
            (revision_id, path, content, content_sha256, size_bytes, executable)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM skill_revisions WHERE id = ?)`
        )
        .bind(
          revisionId,
          file.path,
          file.content,
          file.sha256,
          file.sizeBytes,
          file.executable ? 1 : 0,
          revisionId
        )
    );
  }

  private assignmentInserts(
    skillId: string,
    assignments: SkillAssignmentInput[],
    actorUserId: string,
    now: number,
    requiredCurrentRevisionId?: string
  ): SqlStatement[] {
    return assignments.map((assignment) => {
      const id = `skillassign_${generateId()}`;
      return this.db
        .prepare(
          `INSERT INTO skill_assignments
            (id, skill_id, scope_type, repo_owner, repo_name, environment_id, created_by, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ? IS NULL OR EXISTS (
              SELECT 1 FROM skills WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL
            )`
        )
        .bind(
          id,
          skillId,
          assignment.type,
          assignment.type === "repository" ? assignment.repository.repoOwner : null,
          assignment.type === "repository" ? assignment.repository.repoName : null,
          assignment.type === "environment" ? assignment.environmentId : null,
          actorUserId,
          now,
          requiredCurrentRevisionId ?? null,
          skillId,
          requiredCurrentRevisionId ?? null
        );
    });
  }

  private bumpGeneration(skillId?: string, requiredCurrentRevisionId?: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM skills WHERE id = ? AND current_revision_id = ? AND deleted_at IS NULL
         ))`
      )
      .bind(requiredCurrentRevisionId ?? null, skillId ?? null, requiredCurrentRevisionId ?? null);
  }
}
