import { USER_MERGE_COUNT_KEYS as SHARED_USER_MERGE_COUNT_KEYS } from "@open-inspect/shared/rbac";
import { describe, expect, it } from "vitest";
import { USER_MERGE_COUNT_KEYS } from "./user-merge";

describe("user merge count contract", () => {
  it("reports exactly the counts the shared API contract declares", () => {
    expect([...USER_MERGE_COUNT_KEYS].sort()).toEqual([...SHARED_USER_MERGE_COUNT_KEYS].sort());
  });
});
