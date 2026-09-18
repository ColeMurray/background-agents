import { describe, expect, it } from "vitest";
import { generateEncryptionKey } from "./auth/crypto";
import {
  parseRepoAclConfig,
  requireRepoSecretsEncryptionKey,
  requireTokenEncryptionKey,
} from "./env-validation";
import type { Env } from "./types";

function envWith(key: string | undefined): Env {
  return { REPO_SECRETS_ENCRYPTION_KEY: key } as Env;
}

describe("requireRepoSecretsEncryptionKey", () => {
  it("returns a canonical base64-encoded 32-byte key", () => {
    const key = generateEncryptionKey();

    expect(requireRepoSecretsEncryptionKey(envWith(key))).toBe(key);
  });

  it("throws when the key is absent", () => {
    expect(() => requireRepoSecretsEncryptionKey(envWith(undefined))).toThrow(/not configured/);
  });

  it("throws on malformed base64, including embedded whitespace", () => {
    expect(() => requireRepoSecretsEncryptionKey(envWith("not base64!!"))).toThrow(
      /not valid base64/
    );
    expect(() => requireRepoSecretsEncryptionKey(envWith(`${generateEncryptionKey()}\n`))).toThrow(
      /not valid base64/
    );
  });

  it("throws on keys that decode to the wrong length", () => {
    // Both strings shipped as test fixtures before this validator existed:
    // one decodes to 24 bytes (a silent AES-192 downgrade), one to 34 (a
    // DataError at the first secret write).
    expect(() =>
      requireRepoSecretsEncryptionKey(envWith("0123456789abcdef0123456789abcdef"))
    ).toThrow(/32 bytes.*got 24/);
    expect(() =>
      requireRepoSecretsEncryptionKey(envWith("bm90YXJlYWxrZXlub3RhcmVhbGtleW5vdGFyZWFsa2V5eA=="))
    ).toThrow(/32 bytes.*got 34/);
  });
});

describe("requireTokenEncryptionKey", () => {
  // Shares the material validator with the repo-secrets key; these tests pin
  // the token-specific wiring (which env var is read, whose name errors carry).
  it("returns a canonical base64-encoded 32-byte key", () => {
    const key = generateEncryptionKey();

    expect(requireTokenEncryptionKey({ TOKEN_ENCRYPTION_KEY: key } as Env)).toBe(key);
  });

  it("throws with the token key's name when absent or malformed", () => {
    expect(() => requireTokenEncryptionKey({} as Env)).toThrow(
      /TOKEN_ENCRYPTION_KEY is not configured/
    );
    expect(() =>
      requireTokenEncryptionKey({ TOKEN_ENCRYPTION_KEY: "not base64!!" } as Env)
    ).toThrow(/TOKEN_ENCRYPTION_KEY is not valid base64/);
    expect(() =>
      requireTokenEncryptionKey({ TOKEN_ENCRYPTION_KEY: "dG9vc2hvcnQ=" } as Env)
    ).toThrow(/TOKEN_ENCRYPTION_KEY must decode to 32 bytes/);
  });
});

describe("parseRepoAclConfig", () => {
  it("defaults to enforcement off with an empty allowlist", () => {
    expect(parseRepoAclConfig({} as Env)).toEqual({ enforce: false, allowlist: [] });
  });

  it("does not parse the allowlist while the gate is off", () => {
    expect(parseRepoAclConfig({ REPO_ACL_ALLOWLIST: "acme/api" } as Env)).toEqual({
      enforce: false,
      allowlist: [],
    });
  });

  it.each(["true", "1"])("enables enforcement for ENFORCE_REPO_ACL=%s", (flag) => {
    expect(parseRepoAclConfig({ ENFORCE_REPO_ACL: flag, REPO_ACL_ALLOWLIST: "*" } as Env)).toEqual({
      enforce: true,
      allowlist: [{ owner: "*", name: "*" }],
    });
  });

  it("treats other ENFORCE_REPO_ACL values as off", () => {
    expect(parseRepoAclConfig({ ENFORCE_REPO_ACL: "yes", REPO_ACL_ALLOWLIST: "*" } as Env)).toEqual({
      enforce: false,
      allowlist: [],
    });
  });

  it("ignores a malformed allowlist while the gate is off", () => {
    expect(
      parseRepoAclConfig({ ENFORCE_REPO_ACL: "false", REPO_ACL_ALLOWLIST: "acme/not-a-pattern" } as Env)
    ).toEqual({ enforce: false, allowlist: [] });
  });

  it("refuses to enforce with an empty allowlist", () => {
    expect(() => parseRepoAclConfig({ ENFORCE_REPO_ACL: "true" } as Env)).toThrow(
      /ENFORCE_REPO_ACL is enabled but REPO_ACL_ALLOWLIST is not configured/
    );
  });

  it("propagates malformed allowlist entries", () => {
    expect(() =>
      parseRepoAclConfig({ ENFORCE_REPO_ACL: "true", REPO_ACL_ALLOWLIST: "acme" } as Env)
    ).toThrow(/malformed/);
  });
});
