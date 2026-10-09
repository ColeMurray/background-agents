import { describe, expect, it } from "vitest";

import { memoryRowSchema, parseMemoryCandidateTotal } from "./memory-records";

const validMemoryRow = {
  id: "mem_1",
  partition_type: "repository",
  owner_user_id: null,
  repo_id: 42,
  environment_id: null,
  repo_owner: "acme",
  repo_name: "api",
  memory_type: "fact",
  status: "active",
  archive_kind: null,
  archive_note: null,
  current_revision_id: "rev_1",
  title: "API convention",
  description: "Documents an API convention.",
  content: null,
  revision_number: 1,
  author_kind: "agent",
  author_user_id: null,
  author_session_id: "sess_1",
  supersedes_memory_id: null,
  approved_at: 1_700_000_000_000,
  archived_at: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

describe("memoryRowSchema", () => {
  it("parses a persisted candidate row with nullable fields", () => {
    expect(memoryRowSchema.safeParse(validMemoryRow).success).toBe(true);
  });

  it("rejects malformed persisted candidate rows", () => {
    expect(memoryRowSchema.safeParse({ ...validMemoryRow, memory_type: "note" }).success).toBe(
      false
    );
    expect(memoryRowSchema.safeParse({ ...validMemoryRow, id: 123 }).success).toBe(false);
  });
});

describe("parseMemoryCandidateTotal", () => {
  it("parses the candidate count row", () => {
    expect(parseMemoryCandidateTotal({ total: 3 })).toBe(3);
  });

  it("rejects malformed count rows", () => {
    expect(() => parseMemoryCandidateTotal({ total: "3" })).toThrow("Invalid memory count row");
    expect(() => parseMemoryCandidateTotal(null)).toThrow("Invalid memory count row");
  });
});
