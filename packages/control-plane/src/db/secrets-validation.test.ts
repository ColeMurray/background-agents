import { describe, expect, it } from "vitest";
import {
  normalizeKey,
  validateKey,
  validateValue,
  mergeSecrets,
  SecretsValidationError,
  MAX_VALUE_SIZE,
  MAX_KEY_LENGTH,
} from "./secrets-validation";

describe("normalizeKey", () => {
  it("uppercases keys", () => {
    expect(normalizeKey("foo_bar")).toBe("FOO_BAR");
  });

  it("preserves already uppercased keys", () => {
    expect(normalizeKey("FOO")).toBe("FOO");
  });
});

describe("validateKey", () => {
  it("accepts valid keys", () => {
    expect(() => validateKey("FOO")).not.toThrow();
    expect(() => validateKey("_PRIVATE")).not.toThrow();
    expect(() => validateKey("A1")).not.toThrow();
  });

  it("rejects empty keys", () => {
    expect(() => validateKey("")).toThrow(SecretsValidationError);
  });

  it("rejects keys exceeding max length", () => {
    expect(() => validateKey("A".repeat(MAX_KEY_LENGTH + 1))).toThrow(SecretsValidationError);
  });

  it("rejects keys starting with a digit", () => {
    expect(() => validateKey("1BAD")).toThrow(SecretsValidationError);
  });

  it("rejects keys with special characters", () => {
    expect(() => validateKey("FOO-BAR")).toThrow(SecretsValidationError);
  });

  it("rejects reserved keys", () => {
    expect(() => validateKey("PATH")).toThrow(SecretsValidationError);
    expect(() => validateKey("SANDBOX_ID")).toThrow(SecretsValidationError);
  });

  it("rejects reserved keys case-insensitively", () => {
    expect(() => validateKey("path")).toThrow(SecretsValidationError);
  });
});

describe("validateValue", () => {
  it("accepts valid string values", () => {
    expect(() => validateValue("hello")).not.toThrow();
  });

  it("rejects non-string values", () => {
    expect(() => validateValue(123 as unknown as string)).toThrow(SecretsValidationError);
  });

  it("rejects values exceeding max size", () => {
    expect(() => validateValue("a".repeat(MAX_VALUE_SIZE + 1))).toThrow(SecretsValidationError);
  });

  it("accepts values at max size boundary", () => {
    expect(() => validateValue("a".repeat(MAX_VALUE_SIZE))).not.toThrow();
  });
});

describe("mergeSecrets", () => {
  it("merges global and repo secrets", () => {
    const result = mergeSecrets({ A: "global-a" }, { B: "repo-b" });
    expect(result.merged).toEqual({ A: "global-a", B: "repo-b" });
    expect(result.exceedsLimit).toBe(false);
  });

  it("repo overrides global for same key", () => {
    const result = mergeSecrets({ FOO: "global" }, { FOO: "repo" });
    expect(result.merged).toEqual({ FOO: "repo" });
  });

  it("repo overrides global case-insensitively", () => {
    const result = mergeSecrets({ foo: "global" }, { FOO: "repo" });
    expect(result.merged).toEqual({ FOO: "repo" });
  });

  it("handles empty global", () => {
    const result = mergeSecrets({}, { X: "val" });
    expect(result.merged).toEqual({ X: "val" });
  });

  it("handles empty repo", () => {
    const result = mergeSecrets({ X: "val" }, {});
    expect(result.merged).toEqual({ X: "val" });
  });

  it("handles both empty", () => {
    const result = mergeSecrets({}, {});
    expect(result.merged).toEqual({});
    expect(result.totalBytes).toBe(0);
    expect(result.exceedsLimit).toBe(false);
  });

  it("calculates total bytes correctly", () => {
    const result = mergeSecrets({ A: "hello" }, { B: "world" });
    // "hello" = 5 bytes, "world" = 5 bytes
    expect(result.totalBytes).toBe(10);
  });

  it("reports exceedsLimit when over threshold", () => {
    const big = "x".repeat(100);
    const result = mergeSecrets({ A: big }, { B: big }, 150);
    expect(result.exceedsLimit).toBe(true);
    expect(result.totalBytes).toBe(200);
  });

  it("does not report exceedsLimit at exactly the boundary", () => {
    const result = mergeSecrets({ A: "12345" }, {}, 5);
    expect(result.totalBytes).toBe(5);
    expect(result.exceedsLimit).toBe(false);
  });
});
