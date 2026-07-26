import { describe, expect, it } from "vitest";
import { OAuthFlowVerifierIntegrityError } from "./oauth-flow-verifier";
import {
  InvalidAuthEncryptionRootError,
  ProviderPkceFlowCipher,
  UnsupportedAuthEncryptionVersionError,
  deriveAuthEncryptionKeyBytes,
} from "./auth-encryption";

const ROOT_KEY_BASE64 = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex"
).toString("base64");

describe("terminal auth encryption key derivation", () => {
  it("derives stable, purpose-separated v1 keys from the configured root", async () => {
    const providerKey = await deriveAuthEncryptionKeyBytes(
      ROOT_KEY_BASE64,
      "provider_credentials",
      1
    );
    const flowKey = await deriveAuthEncryptionKeyBytes(ROOT_KEY_BASE64, "provider_pkce_flow", 1);

    expect(Buffer.from(providerKey).toString("hex")).toBe(
      "435bee8840d77453bcf2a1e08d603cb781b24d71d4b0488fbc475c45b21f4939"
    );
    expect(Buffer.from(flowKey).toString("hex")).toBe(
      "41a9432e1831f5202c5561c2d31e98d3ab1eff1df5dbd774f8a4c99ce567bdd4"
    );
    expect(providerKey).not.toEqual(flowKey);
  });

  it("rejects malformed roots and unsupported key versions", async () => {
    await expect(
      deriveAuthEncryptionKeyBytes("not-a-32-byte-base64-key", "provider_pkce_flow", 1)
    ).rejects.toBeInstanceOf(InvalidAuthEncryptionRootError);
    await expect(
      deriveAuthEncryptionKeyBytes(ROOT_KEY_BASE64, "provider_pkce_flow", 2)
    ).rejects.toBeInstanceOf(UnsupportedAuthEncryptionVersionError);
  });
});

describe("ProviderPkceFlowCipher", () => {
  it("binds a verifier to its flow, provider, and key version", async () => {
    const cipher = new ProviderPkceFlowCipher(ROOT_KEY_BASE64);
    const context = {
      flowId: "flow-1",
      provider: "google" as const,
      keyVersion: 1,
    };

    const encrypted = await cipher.encrypt("provider-pkce-verifier", context);

    await expect(cipher.decrypt(encrypted, context)).resolves.toBe("provider-pkce-verifier");
    await expect(
      cipher.decrypt(encrypted, { ...context, provider: "github" })
    ).rejects.toBeInstanceOf(OAuthFlowVerifierIntegrityError);
  });

  it("uses an injected initialization vector and preserves round-trip decryption", async () => {
    const initializationVector = Uint8Array.from({ length: 12 }, (_, index) => index);
    const cipher = new ProviderPkceFlowCipher(ROOT_KEY_BASE64, {
      ivGenerator: { generate: () => initializationVector },
    });
    const context = {
      flowId: "flow-1",
      provider: "google" as const,
      keyVersion: 1,
    };

    const encrypted = await cipher.encrypt("provider-pkce-verifier", context);

    expect(Buffer.from(encrypted, "base64").subarray(0, initializationVector.byteLength)).toEqual(
      Buffer.from(initializationVector)
    );
    await expect(cipher.decrypt(encrypted, context)).resolves.toBe("provider-pkce-verifier");
  });

  it("rejects an invalid initialization-vector length", async () => {
    const cipher = new ProviderPkceFlowCipher(ROOT_KEY_BASE64, {
      ivGenerator: { generate: () => new Uint8Array(11) },
    });

    await expect(
      cipher.encrypt("provider-pkce-verifier", {
        flowId: "flow-1",
        provider: "google",
        keyVersion: 1,
      })
    ).rejects.toThrow("Provider PKCE flow IV generator returned an invalid IV");
  });
});
