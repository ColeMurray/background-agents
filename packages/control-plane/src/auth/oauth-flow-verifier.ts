import type { SignInProvider } from "./sign-in-provider";

export interface OAuthFlowVerifierBinding {
  flowId: string;
  provider: SignInProvider;
  keyVersion: number;
}

/**
 * Stable integrity failure exposed by the verifier-cipher port. Implementations
 * must throw this when ciphertext cannot be authenticated or decoded.
 */
export class OAuthFlowVerifierIntegrityError extends Error {
  constructor() {
    super("OAuth flow verifier ciphertext could not be verified");
    this.name = "OAuthFlowVerifierIntegrityError";
  }
}

export interface OAuthFlowVerifierCipher {
  encrypt(plaintext: string, binding: OAuthFlowVerifierBinding): Promise<string>;
  decrypt(ciphertext: string, binding: OAuthFlowVerifierBinding): Promise<string>;
}
