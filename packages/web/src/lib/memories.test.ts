import { describe, expect, it } from "vitest";
import type { MemoryDto } from "@open-inspect/shared/types/memories";
import { bulkActionSummary, memorySettingsLink } from "./memories";

describe("memorySettingsLink", () => {
  it.each([
    [{ type: "personal" } as const, "/settings?scope=personal&tab=memories&memoryId=mem_a"],
    [
      { type: "repository", repoOwner: "group/sub", repoName: "web" } as const,
      "/settings?scope=shared&tab=shared-memories&memoryId=mem_a",
    ],
    [
      { type: "environment", environmentId: "env_1" } as const,
      "/settings?scope=environment&environmentId=env_1&tab=shared-memories&memoryId=mem_a",
    ],
  ])("links %j to its management tab", (scope, expected) => {
    expect(memorySettingsLink(scope, "mem_a")).toBe(expected);
  });

  it("ignores historical or reused repository names and encodes the record ID", () => {
    const oldScope = { type: "repository" as const, repoOwner: "old/group", repoName: "reused" };
    expect(memorySettingsLink(oldScope, "mem/a?b")).toBe(
      "/settings?scope=shared&tab=shared-memories&memoryId=mem%2Fa%3Fb"
    );
  });
});

describe("bulkActionSummary", () => {
  const records = [
    { id: "mem_a", title: "Use pnpm" },
    { id: "mem_b", title: "Run migrations first" },
  ];
  it("counts applied records and names each failure with its reason", () => {
    expect(
      bulkActionSummary("approve", records, [
        { id: "mem_a", ok: true, memory: {} as MemoryDto },
        { id: "mem_b", ok: false, error: "Memory changed; reload before acting" },
      ])
    ).toEqual({
      applied: "Approved 1 of 2 memories.",
      failed:
        "Could not approve 1 memory: “Run migrations first” (Memory changed; reload before acting).",
    });
  });

  it("reports only what happened", () => {
    expect(
      bulkActionSummary(
        "archive",
        records,
        records.map(({ id }) => ({ id, ok: true, memory: {} as MemoryDto }))
      )
    ).toEqual({ applied: "Archived 2 memories.", failed: null });
    expect(
      bulkActionSummary("reject", records, [
        { id: "mem_gone", ok: false, error: "Memory not found" },
      ])
    ).toEqual({
      applied: null,
      failed: "Could not reject 1 memory: “mem_gone” (Memory not found).",
    });
  });
});
