import type { MemoryScope } from "@open-inspect/shared/types/memories";
import { bulkInsertStatements } from "../../src/db/bulk-insert";
import type { SqlDatabase } from "../../src/db/sql-database";

export interface SearchFactFixture {
  id: string;
  title?: string;
  description?: string;
  content?: string;
  scope?: MemoryScope;
  repoId?: number | null;
  ownerUserId?: string;
  status?: "active" | "proposed" | "archived";
  memoryType?: "fact" | "directive";
  updatedAt?: number;
}
/** Seed immutable current revisions without thousands of domain API round trips in corpus tests. */
export async function seedSearchFacts(db: SqlDatabase, owner: string, facts: SearchFactFixture[]) {
  const memories = facts.map((fact) => {
    const scope = fact.scope ?? { type: "personal" };
    return {
      id: fact.id,
      scope_type: scope.type,
      owner_user_id: scope.type === "personal" ? (fact.ownerUserId ?? owner) : null,
      repo_owner: scope.type === "repository" ? scope.repoOwner : null,
      repo_name: scope.type === "repository" ? scope.repoName : null,
      repo_id: fact.repoId ?? null,
      environment_id: scope.type === "environment" ? scope.environmentId : null,
      memory_type: fact.memoryType ?? "fact",
      status: fact.status ?? "active",
      current_revision_id: `rev_${fact.id}`,
      author_kind: "user",
      author_user_id: owner,
      last_operation_id: `op_${fact.id}`,
      created_at: fact.updatedAt ?? 1,
      updated_at: fact.updatedAt ?? 1,
      archived_at: fact.status === "archived" ? 1 : null,
    };
  });
  const revisions = facts.map((fact) => ({
    id: `rev_${fact.id}`,
    memory_id: fact.id,
    revision_number: 1,
    memory_type: fact.memoryType ?? "fact",
    title: fact.title ?? "Routine knowledge",
    description: fact.description ?? "Ordinary project knowledge",
    content: fact.content ?? "Ordinary fact body",
    content_sha256: "synthetic-fixture",
    author_kind: "user",
    author_user_id: owner,
    created_at: fact.updatedAt ?? 1,
  }));
  const statements = [
    ...bulkInsertStatements(db, "memories", memories),
    ...bulkInsertStatements(db, "memory_revisions", revisions),
  ];
  for (let index = 0; index < statements.length; index += 50)
    await db.batch(statements.slice(index, index + 50));
}
