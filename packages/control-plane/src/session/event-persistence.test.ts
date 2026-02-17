import { describe, expect, it } from "vitest";
import { shouldPersistToolCallEvent } from "./event-persistence";

describe("shouldPersistToolCallEvent", () => {
  it("persists terminal statuses", () => {
    expect(shouldPersistToolCallEvent("completed")).toBe(true);
    expect(shouldPersistToolCallEvent("error")).toBe(true);
  });

  it("persists missing statuses", () => {
    expect(shouldPersistToolCallEvent(undefined)).toBe(true);
    expect(shouldPersistToolCallEvent(null)).toBe(true);
  });

  it("persists empty and whitespace statuses", () => {
    expect(shouldPersistToolCallEvent("")).toBe(true);
    expect(shouldPersistToolCallEvent("   ")).toBe(true);
  });

  it("does not persist non-terminal statuses", () => {
    expect(shouldPersistToolCallEvent("pending")).toBe(false);
    expect(shouldPersistToolCallEvent("running")).toBe(false);
  });
});
