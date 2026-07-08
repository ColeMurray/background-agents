import { describe, expect, it, vi } from "vitest";
import {
  auditSecretsMerge,
  formatSecretsAttribution,
  MAX_COMBINED_SECRETS_BYTES,
  mergeSecretSources,
  normalizeKey,
  parseSecretsCapMode,
  SecretsCapExceededError,
  SecretsValidationError,
  validateKey,
  validateValue,
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

describe("mergeSecretSources", () => {
  // The old two-arg mergeSecrets(global, repo) is the two-source fold below.
  it("merges global and repo secrets", () => {
    const result = mergeSecretSources([
      { label: "global", secrets: { A: "global-a" } },
      { label: "acme/web", secrets: { B: "repo-b" } },
    ]);
    expect(result.merged).toEqual({ A: "global-a", B: "repo-b" });
    expect(result.exceedsLimit).toBe(false);
  });

  it("later sources override earlier ones for the same key", () => {
    const result = mergeSecretSources([
      { label: "global", secrets: { FOO: "global" } },
      { label: "acme/web", secrets: { FOO: "repo" } },
    ]);
    expect(result.merged).toEqual({ FOO: "repo" });
  });

  it("overrides case-insensitively", () => {
    const result = mergeSecretSources([
      { label: "global", secrets: { foo: "global" } },
      { label: "acme/web", secrets: { FOO: "repo" } },
    ]);
    expect(result.merged).toEqual({ FOO: "repo" });
  });

  it("folds members lowest-precedence-first so the primary (last) wins", () => {
    const result = mergeSecretSources([
      { label: "global", secrets: { SHARED: "g", ONLY_GLOBAL: "g" } },
      { label: "acme/backend", secrets: { SHARED: "backend", ONLY_BACKEND: "b" } },
      { label: "acme/web", secrets: { SHARED: "web", ONLY_WEB: "w" } },
    ]);
    expect(result.merged).toEqual({
      SHARED: "web",
      ONLY_GLOBAL: "g",
      ONLY_BACKEND: "b",
      ONLY_WEB: "w",
    });
  });

  it("handles empty sources", () => {
    expect(mergeSecretSources([]).merged).toEqual({});
    expect(mergeSecretSources([{ label: "global", secrets: {} }]).totalBytes).toBe(0);
  });

  it("calculates total bytes across the merged payload", () => {
    const result = mergeSecretSources([
      { label: "global", secrets: { A: "hello" } },
      { label: "acme/web", secrets: { B: "world" } },
    ]);
    expect(result.totalBytes).toBe(10);
    expect(result.maxCombinedBytes).toBe(MAX_COMBINED_SECRETS_BYTES);
  });

  it("reports exceedsLimit above the threshold and not at the boundary", () => {
    const big = "x".repeat(100);
    const over = mergeSecretSources(
      [
        { label: "global", secrets: { A: big } },
        { label: "acme/web", secrets: { B: big } },
      ],
      150
    );
    expect(over.exceedsLimit).toBe(true);
    expect(over.totalBytes).toBe(200);

    const boundary = mergeSecretSources([{ label: "global", secrets: { A: "12345" } }], 5);
    expect(boundary.totalBytes).toBe(5);
    expect(boundary.exceedsLimit).toBe(false);
  });

  it("attributes surviving bytes and keys to the winning source, omitting empty sources", () => {
    const result = mergeSecretSources([
      { label: "global", secrets: { SHARED: "g", ONLY_GLOBAL: "gg" } },
      { label: "acme/empty", secrets: {} },
      { label: "acme/web", secrets: { SHARED: "webwin" } },
    ]);
    // global keeps ONLY_GLOBAL (2 bytes); web owns SHARED (6 bytes); empty omitted.
    expect(result.attribution).toEqual([
      { label: "global", keyCount: 1, bytes: 2 },
      { label: "acme/web", keyCount: 1, bytes: 6 },
    ]);
  });

  it("records cross-source collisions with winner and loser labels", () => {
    const result = mergeSecretSources([
      { label: "global", secrets: { SHARED: "g" } },
      { label: "acme/backend", secrets: { SHARED: "b" } },
      { label: "acme/web", secrets: { SHARED: "w", UNIQUE: "u" } },
    ]);
    expect(result.collisions).toEqual([
      { key: "SHARED", winner: "acme/backend", loser: "global" },
      { key: "SHARED", winner: "acme/web", loser: "acme/backend" },
    ]);
  });

  it("reports no collisions when keys are disjoint", () => {
    const result = mergeSecretSources([
      { label: "global", secrets: { A: "1" } },
      { label: "acme/web", secrets: { B: "2" } },
    ]);
    expect(result.collisions).toEqual([]);
  });
});

describe("parseSecretsCapMode", () => {
  it("returns enforce only for the literal 'enforce'", () => {
    expect(parseSecretsCapMode("enforce")).toBe("enforce");
  });

  it("defaults to warn for unset or unknown values", () => {
    expect(parseSecretsCapMode(undefined)).toBe("warn");
    expect(parseSecretsCapMode("warn")).toBe("warn");
    expect(parseSecretsCapMode("ENFORCE")).toBe("warn");
  });
});

describe("formatSecretsAttribution", () => {
  it("renders sources largest-first with byte and key counts", () => {
    expect(
      formatSecretsAttribution([
        { label: "global", keyCount: 1, bytes: 10 },
        { label: "acme/web", keyCount: 2, bytes: 100 },
      ])
    ).toBe("acme/web (100 bytes, 2 keys), global (10 bytes, 1 keys)");
  });
});

describe("auditSecretsMerge", () => {
  function createLog() {
    return { warn: vi.fn(), error: vi.fn() };
  }

  it("logs each cross-source collision as a warning", () => {
    const log = createLog();
    const merge = mergeSecretSources([
      { label: "global", secrets: { SHARED: "g" } },
      { label: "acme/web", secrets: { SHARED: "w" } },
    ]);
    auditSecretsMerge({ merge, mode: "warn", log });
    expect(log.warn).toHaveBeenCalledWith(
      "secrets.key_collision",
      expect.objectContaining({ key: "SHARED", winner: "acme/web", overridden: "global" })
    );
  });

  it("warns but does not throw for an oversized payload in warn mode", () => {
    const log = createLog();
    const merge = mergeSecretSources([{ label: "global", secrets: { A: "x".repeat(10) } }], 5);
    expect(() => auditSecretsMerge({ merge, mode: "warn", log })).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      "secrets.cap_exceeded",
      expect.objectContaining({ enforcement: "warn", total_bytes: 10, max_bytes: 5 })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("throws SecretsCapExceededError and logs an error in enforce mode", () => {
    const log = createLog();
    const merge = mergeSecretSources([{ label: "global", secrets: { A: "x".repeat(10) } }], 5);
    expect(() => auditSecretsMerge({ merge, mode: "enforce", log })).toThrow(
      SecretsCapExceededError
    );
    expect(log.error).toHaveBeenCalledWith(
      "secrets.cap_exceeded",
      expect.objectContaining({ enforcement: "enforce" })
    );
  });

  it("does not emit a cap log when under the limit", () => {
    const log = createLog();
    const merge = mergeSecretSources([{ label: "global", secrets: { A: "ok" } }]);
    auditSecretsMerge({ merge, mode: "enforce", log });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("SecretsCapExceededError", () => {
  it("names the largest contributing scopes in its message", () => {
    const error = new SecretsCapExceededError(200, 150, [
      { label: "global", keyCount: 1, bytes: 40 },
      { label: "acme/web", keyCount: 3, bytes: 160 },
    ]);
    expect(error.message).toContain("200 bytes");
    expect(error.message).toContain("150-byte limit");
    expect(error.message).toContain("acme/web (160 bytes, 3 keys)");
  });
});
