import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "./errors";

describe("isUniqueConstraintError", () => {
  it("recognizes D1's message text", () => {
    expect(isUniqueConstraintError(new Error("D1_ERROR: UNIQUE constraint failed: t.k"))).toBe(
      true
    );
    expect(isUniqueConstraintError(new Error("no such table: t"))).toBe(false);
  });

  it("recognizes the SQLite result codes node:sqlite carries, whatever the message", () => {
    const withCode = (errcode: number): Error =>
      Object.assign(new Error("constraint failed"), { errcode });
    expect(isUniqueConstraintError(withCode(2067))).toBe(true);
    expect(isUniqueConstraintError(withCode(1555))).toBe(true);
    expect(isUniqueConstraintError(withCode(787))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});
