import { describe, expect, it, vi } from "vitest";
import {
  decryptStoredAccessValue,
  isValidSandboxToken,
  resolveSandboxDashboardUrl,
} from "./sandbox-access";
import { encryptToken, generateEncryptionKey, hashToken } from "../auth/crypto";
import type { SandboxRow } from "./types";

const ENCRYPTION_KEY = generateEncryptionKey();

function sandboxRow(overrides: Partial<SandboxRow>): SandboxRow {
  return { auth_token: null, auth_token_hash: null, ...overrides } as SandboxRow;
}

function warnLog() {
  return { warn: vi.fn() };
}

describe("isValidSandboxToken", () => {
  it("prefers the stored hash over the plaintext fallback", async () => {
    const sandbox = sandboxRow({
      auth_token_hash: await hashToken("real-token"),
      auth_token: "some-other-token",
    });

    await expect(isValidSandboxToken("real-token", sandbox)).resolves.toBe(true);
    await expect(isValidSandboxToken("some-other-token", sandbox)).resolves.toBe(false);
  });

  it("falls back to the plaintext token for rows written before hashing", async () => {
    const sandbox = sandboxRow({ auth_token: "legacy-token" });

    await expect(isValidSandboxToken("legacy-token", sandbox)).resolves.toBe(true);
    await expect(isValidSandboxToken("wrong-token", sandbox)).resolves.toBe(false);
  });

  it("rejects when the sandbox carries no credential at all", async () => {
    await expect(isValidSandboxToken("any-token", sandboxRow({}))).resolves.toBe(false);
  });

  it("rejects a missing token or a missing sandbox", async () => {
    await expect(isValidSandboxToken(null, sandboxRow({ auth_token: "t" }))).resolves.toBe(false);
    await expect(isValidSandboxToken("", sandboxRow({ auth_token: "t" }))).resolves.toBe(false);
    await expect(isValidSandboxToken("t", null)).resolves.toBe(false);
  });
});

describe("decryptStoredAccessValue", () => {
  it("resolves null for an absent value without consulting the key", async () => {
    const log = warnLog();

    await expect(decryptStoredAccessValue(null, ENCRYPTION_KEY, log)).resolves.toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns the value verbatim when no encryption key is configured", async () => {
    const log = warnLog();

    await expect(decryptStoredAccessValue("plaintext", undefined, log)).resolves.toBe("plaintext");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("round-trips a value encrypted with the configured key", async () => {
    const encrypted = await encryptToken("s3cret", ENCRYPTION_KEY);

    await expect(decryptStoredAccessValue(encrypted, ENCRYPTION_KEY, warnLog())).resolves.toBe(
      "s3cret"
    );
  });

  it("warns and resolves null when the stored value cannot be decrypted", async () => {
    const log = warnLog();

    await expect(
      decryptStoredAccessValue("not-encrypted", ENCRYPTION_KEY, log)
    ).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "Failed to decrypt stored sandbox access value",
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe("resolveSandboxDashboardUrl", () => {
  const modal = {
    sandboxProvider: "modal",
    modalWorkspace: "acme",
    modalEnvironment: "prod",
  };

  it("builds a Modal dashboard URL for the provider object", () => {
    expect(resolveSandboxDashboardUrl(modal, "sb-123")).toBe(
      "https://modal.com/apps/acme/prod/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("returns null for every non-Modal backend", () => {
    expect(resolveSandboxDashboardUrl({ ...modal, sandboxProvider: "e2b" }, "sb-123")).toBeNull();
    expect(
      resolveSandboxDashboardUrl({ ...modal, sandboxProvider: "daytona" }, "sb-123")
    ).toBeNull();
  });

  it("treats an unset provider as the Modal default", () => {
    expect(resolveSandboxDashboardUrl({ ...modal, sandboxProvider: undefined }, "sb-123")).toBe(
      "https://modal.com/apps/acme/prod/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("returns null without a workspace or without a provider object id", () => {
    expect(
      resolveSandboxDashboardUrl({ ...modal, modalWorkspace: undefined }, "sb-123")
    ).toBeNull();
    expect(resolveSandboxDashboardUrl(modal, null)).toBeNull();
    expect(resolveSandboxDashboardUrl(modal, undefined)).toBeNull();
  });
});
