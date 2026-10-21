import { describe, expect, it } from "vitest";
import {
  MAX_BULK_SKILL_IMPORT_ASSIGNMENTS,
  MAX_BULK_SKILL_IMPORT_FILES,
  MAX_BULK_SKILL_IMPORT_SKILLS,
  type SkillAssignmentInput,
  type SkillImportSource,
} from "@open-inspect/shared/types/skills";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { SkillStore, SkillValidationError, type ImportedSkillCreateInput } from "./skills";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function recordingDatabase(options: { foreignKeyFailure?: boolean; heldName?: string } = {}): {
  db: SqlDatabase;
  prepared: RecordedStatement[];
  batches: RecordedStatement[][];
} {
  const prepared: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const statementRecords = new WeakMap<SqlStatement, RecordedStatement>();
  const db: SqlDatabase = {
    prepare(sql: string): SqlStatement {
      const record = { sql, values: [] as unknown[] };
      prepared.push(record);
      const statement: SqlStatement = {
        bind(...values: unknown[]) {
          record.values = values;
          return statement;
        },
        async first<T>() {
          if (sql.includes("FROM environments")) {
            return { count: record.values.length } as T;
          }
          return null;
        },
        async run<T>() {
          return { results: [], meta: { changes: 0 } } as SqlResult<T>;
        },
        async all<T>() {
          const results =
            options.heldName && record.values.includes(options.heldName)
              ? [{ name: options.heldName }]
              : [];
          return { results, meta: { changes: 0 } } as SqlResult<T>;
        },
      };
      statementRecords.set(statement, record);
      return statement;
    },
    async batch<T>(statements: SqlStatement[]) {
      batches.push(statements.map((statement) => statementRecords.get(statement)!));
      if (options.foreignKeyFailure) throw new Error("FOREIGN KEY constraint failed");
      return statements.map(() => ({ results: [], meta: { changes: 1 } })) as SqlResult<T>[];
    },
  };
  return { db, prepared, batches };
}

const source: SkillImportSource = {
  provider: "github",
  repoOwner: "acme",
  repoName: "skills",
  requestedRef: null,
  resolvedRef: "main",
  commitSha: "a".repeat(40),
  subdirectory: "catalog/skill-0",
  sourceSha256: "b".repeat(64),
};

function scaleInputs(): ImportedSkillCreateInput[] {
  const filesPerSkill = MAX_BULK_SKILL_IMPORT_FILES / MAX_BULK_SKILL_IMPORT_SKILLS - 1;
  return Array.from({ length: MAX_BULK_SKILL_IMPORT_SKILLS }, (_, skillIndex) => ({
    name: `skill-${skillIndex}`,
    content: {
      description: `Skill ${skillIndex}`,
      body: "body\n",
      metadata: {},
      files: Array.from({ length: filesPerSkill }, (_, fileIndex) => ({
        path: `references/file-${fileIndex}.md`,
        content: "x",
        executable: false,
      })),
    },
    source: {
      ...source,
      subdirectory: `catalog/skill-${skillIndex}`,
      sourceSha256: skillIndex.toString(16).padStart(64, "0"),
    },
  }));
}

function maxAssignments(): SkillAssignmentInput[] {
  return Array.from({ length: MAX_BULK_SKILL_IMPORT_ASSIGNMENTS }, (_, index) => ({
    type: "environment" as const,
    environmentId: `env-${index}`,
  }));
}

describe("SkillStore bulk imports", () => {
  it("packs the declared maximum import comfortably below the D1 query budget", async () => {
    const { db, prepared, batches } = recordingDatabase();
    const created = await new SkillStore(db).createImportedSkills(
      scaleInputs(),
      maxAssignments(),
      "user-1"
    );

    expect(created).toHaveLength(MAX_BULK_SKILL_IMPORT_SKILLS);
    expect(batches).toHaveLength(1);
    expect(2 + batches[0].length).toBe(283);
    expect(2 + batches[0].length).toBeLessThan(1_000);
    expect(prepared.every((statement) => statement.values.length <= MAX_D1_QUERY_PARAMETERS)).toBe(
      true
    );
    expect(
      batches[0].filter((statement) => statement.sql.includes("skill_revision_files"))
    ).toHaveLength(32);
    expect(
      batches[0].filter((statement) => statement.sql.includes("skill_assignments"))
    ).toHaveLength(209);
  });

  it("checks availability with chunked set queries including reserved and held names", async () => {
    const { db, prepared } = recordingDatabase({ heldName: "held-name" });
    const names = [
      "agent-browser",
      "held-name",
      ...Array.from({ length: 203 }, (_, index) => `free-${index}`),
    ];

    const unavailable = await new SkillStore(db).unavailableNames(names);

    expect(unavailable).toEqual(new Set(["agent-browser", "held-name"]));
    expect(prepared).toHaveLength(3);
    expect(prepared.map((statement) => statement.values.length)).toEqual([100, 100, 5]);
  });

  it("translates an assignment foreign-key race after validation", async () => {
    const { db, batches } = recordingDatabase({ foreignKeyFailure: true });

    await expect(
      new SkillStore(db).createImportedSkills(
        [scaleInputs()[0]],
        [{ type: "environment", environmentId: "env-1" }],
        "user-1"
      )
    ).rejects.toThrow(
      new SkillValidationError("One or more assigned environments no longer exist")
    );
    expect(batches).toHaveLength(1);
  });
});
