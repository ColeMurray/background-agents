import type { ProviderCredentialKind } from "./provider-credential";

export interface ProviderCredentialCipherBinding {
  providerIdentityId: string;
  credentialKind: ProviderCredentialKind;
  tokenRole: "access" | "refresh";
  encryptionKeyVersion: number;
  rowVersion: number;
}

/**
 * Stable integrity failure exposed by the provider-credential cipher port.
 * Implementations must throw this when ciphertext cannot be authenticated or
 * decoded.
 */
export class ProviderCredentialIntegrityError extends Error {
  constructor() {
    super("Provider credential ciphertext could not be verified");
    this.name = "ProviderCredentialIntegrityError";
  }
}

/** Encrypts provider tokens while binding them to their exact persisted row. */
export interface ProviderCredentialCipherPort {
  encrypt(plaintext: string, binding: ProviderCredentialCipherBinding): Promise<string>;
  decrypt(ciphertext: string, binding: ProviderCredentialCipherBinding): Promise<string>;
}
