import { describe, expect, it } from "vitest";

import { memoryManifestRowSchema, pinnedMemoryItemRowSchema } from "./session-memory-selections";

const validManifestRow = {
  selection_version: 1,
  manifest_sha256: "abc123",
  resolved_at: 1_700_000_000_000,
  personal_owner_user_id: null,
  directive_chars: 10,
  catalog_chars: 20,
  estimated_tokens: 8,
  omitted_count: 0,
};

const validPinnedItemRow = {
  memory_id: "mem_1",
  revision_id: "rev_1",
  revision_number: 1,
  memory_type: "directive",
  title: "Use pnpm",
  description: "Use the package manager configured by the repository.",
  content: null,
  scope_json: JSON.stringify({ type: "personal" }),
  inclusion: "summary",
  estimated_tokens: 8,
  current_revision_id: "rev_2",
  status: "archived",
  partition_type: "personal",
  owner_user_id: "user_1",
  repo_id: null,
  environment_id: null,
};

describe("memoryManifestRowSchema", () => {
  it("parses a persisted manifest row with a null personal owner", () => {
    expect(memoryManifestRowSchema.safeParse(validManifestRow).success).toBe(true);
  });

  it("rejects malformed persisted manifest rows", () => {
    expect(
      memoryManifestRowSchema.safeParse({ ...validManifestRow, selection_version: "1" }).success
    ).toBe(false);
  });
});

describe("pinnedMemoryItemRowSchema", () => {
  it("parses a persisted pinned item row with nullable fields", () => {
    expect(pinnedMemoryItemRowSchema.safeParse(validPinnedItemRow).success).toBe(true);
  });

  it("rejects malformed persisted pinned item rows", () => {
    expect(
      pinnedMemoryItemRowSchema.safeParse({ ...validPinnedItemRow, status: "deleted" }).success
    ).toBe(false);
    expect(
      pinnedMemoryItemRowSchema.safeParse({ ...validPinnedItemRow, revision_id: null }).success
    ).toBe(false);
  });
});
