import { describe, expect, it } from "vitest";
import { generateEncryptionKey } from "./crypto";
import {
  decryptProviderAccountPayload,
  encryptProviderAccountPayload,
} from "./provider-account-crypto";

const context = {
  providerAccountId: "account-1",
  provider: "openai",
  credentialSchemaVersion: 2,
} as const;

describe("provider account crypto", () => {
  it("round-trips a versioned credential payload", async () => {
    const key = generateEncryptionKey();
    const payload = { refreshToken: "refresh-secret", accessToken: "access-secret" };

    const encrypted = await encryptProviderAccountPayload(payload, key, context);

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("refresh-secret");
    await expect(decryptProviderAccountPayload(encrypted, key, context)).resolves.toEqual(payload);
  });

  it.each([
    ["account", { ...context, providerAccountId: "account-2" }],
    ["provider", { ...context, provider: "xai" }],
    ["schema version", { ...context, credentialSchemaVersion: 3 }],
  ])("rejects ciphertext moved to another %s context", async (_target, otherContext) => {
    const key = generateEncryptionKey();
    const encrypted = await encryptProviderAccountPayload({ refreshToken: "secret" }, key, context);

    await expect(decryptProviderAccountPayload(encrypted, key, otherContext)).rejects.toThrow();
  });

  it("rejects unknown encryption format versions", async () => {
    await expect(
      decryptProviderAccountPayload("v2.invalid.invalid", generateEncryptionKey(), context)
    ).rejects.toThrow(/format version/i);
  });

  it("rejects payloads that cannot be JSON encoded", async () => {
    await expect(
      encryptProviderAccountPayload(undefined, generateEncryptionKey(), context)
    ).rejects.toThrow(/JSON encoded/);
  });
});
