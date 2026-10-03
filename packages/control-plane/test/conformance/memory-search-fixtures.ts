import { bulkInsertStatements } from "../../src/db/bulk-insert";
import type { SqlDatabase } from "../../src/db/sql-database";
import { partitionColumns, type MemoryPartition } from "../../src/memory/partition";

export interface SearchFactFixture {
  id: string;
  title?: string;
  description?: string;
  content?: string;
  /** Defaults to the seeding owner's personal partition. */
  partition?: MemoryPartition;
  status?: "active" | "proposed" | "archived";
  memoryType?: "fact" | "directive";
  updatedAt?: number;
}
/** Seed immutable current revisions without thousands of domain API round trips in corpus tests. */
export async function seedSearchFacts(db: SqlDatabase, owner: string, facts: SearchFactFixture[]) {
  const memories = facts.map((fact) => ({
    id: fact.id,
    ...partitionColumns(fact.partition ?? { type: "personal", userId: owner }),
    memory_type: fact.memoryType ?? "fact",
    status: fact.status ?? "active",
    current_revision_id: `rev_${fact.id}`,
    author_kind: "user",
    author_user_id: owner,
    last_operation_id: `op_${fact.id}`,
    created_at: fact.updatedAt ?? 1,
    updated_at: fact.updatedAt ?? 1,
    archived_at: fact.status === "archived" ? 1 : null,
    archive_kind: fact.status === "archived" ? "archived" : null,
  }));
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
