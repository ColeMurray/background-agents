import {
  OAuthFlowVerifierIntegrityError,
  type OAuthFlowVerifierBinding,
} from "./oauth-flow-verifier";

export type AuthEncryptionPurpose = "provider_credentials" | "provider_pkce_flow";

const HKDF_SALT = "openinspect/auth-key-derivation/v1";
const V1_PURPOSE_INFO: Readonly<Record<AuthEncryptionPurpose, string>> = {
  provider_credentials: "openinspect/provider-credentials/v1",
  provider_pkce_flow: "openinspect/provider-pkce-flow/v1",
};

export class UnsupportedAuthEncryptionVersionError extends Error {
  constructor(readonly version: number) {
    super("Unsupported authentication encryption version");
    this.name = "UnsupportedAuthEncryptionVersionError";
  }
}

export class InvalidAuthEncryptionRootError extends Error {
  constructor() {
    super("Authentication encryption root must be exactly 32 base64-encoded bytes");
    this.name = "InvalidAuthEncryptionRootError";
  }
}

function decodeRootKey(rootKeyBase64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(rootKeyBase64)) {
    throw new InvalidAuthEncryptionRootError();
  }

  try {
    const decoded = Uint8Array.from(atob(rootKeyBase64), (character) => character.charCodeAt(0));
    if (decoded.byteLength === 32) return decoded;
  } catch {
    // Normalize platform decoding errors into the stable configuration error.
  }
  throw new InvalidAuthEncryptionRootError();
}

export async function deriveAuthEncryptionKeyBytes(
  rootKeyBase64: string,
  purpose: AuthEncryptionPurpose,
  version: number
): Promise<Uint8Array> {
  if (version !== 1) throw new UnsupportedAuthEncryptionVersionError(version);

  const encoder = new TextEncoder();
  const rootKey = await crypto.subtle.importKey(
    "raw",
    decodeRootKey(rootKeyBase64),
    "HKDF",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(V1_PURPOSE_INFO[purpose]),
    },
    rootKey,
    256
  );
  return new Uint8Array(bits);
}

export interface InitializationVectorGenerator {
  generate(): Uint8Array;
}

const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

function providerPkceFlowAssociatedData(context: OAuthFlowVerifierBinding): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(["provider_pkce_flow", context.flowId, context.provider, context.keyVersion])
  );
}

function encodeCiphertext(iv: Uint8Array, ciphertext: ArrayBuffer): string {
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

function decodeCiphertext(value: string): { iv: Uint8Array; ciphertext: Uint8Array } {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new OAuthFlowVerifierIntegrityError();
  }

  try {
    const combined = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (combined.byteLength <= AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES) {
      throw new OAuthFlowVerifierIntegrityError();
    }
    return {
      iv: combined.slice(0, AES_GCM_IV_BYTES),
      ciphertext: combined.slice(AES_GCM_IV_BYTES),
    };
  } catch (error) {
    if (error instanceof OAuthFlowVerifierIntegrityError) throw error;
    throw new OAuthFlowVerifierIntegrityError();
  }
}

export class ProviderPkceFlowCipher {
  private readonly keys = new Map<number, Promise<CryptoKey>>();
  private readonly ivGenerator: InitializationVectorGenerator;

  constructor(
    private readonly rootKeyBase64: string,
    dependencies: { readonly ivGenerator?: InitializationVectorGenerator } = {}
  ) {
    this.ivGenerator = dependencies.ivGenerator ?? {
      generate: () => crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES)),
    };
  }

  async encrypt(plaintext: string, context: OAuthFlowVerifierBinding): Promise<string> {
    const iv = this.ivGenerator.generate();
    if (iv.byteLength !== AES_GCM_IV_BYTES) {
      throw new Error("Provider PKCE flow IV generator returned an invalid IV");
    }
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: providerPkceFlowAssociatedData(context),
      },
      await this.getKey(context.keyVersion),
      new TextEncoder().encode(plaintext)
    );
    return encodeCiphertext(iv, ciphertext);
  }

  async decrypt(encrypted: string, context: OAuthFlowVerifierBinding): Promise<string> {
    const { iv, ciphertext } = decodeCiphertext(encrypted);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: providerPkceFlowAssociatedData(context),
        },
        await this.getKey(context.keyVersion),
        ciphertext
      );
      return new TextDecoder().decode(plaintext);
    } catch (error) {
      if (error instanceof UnsupportedAuthEncryptionVersionError) throw error;
      if (error instanceof InvalidAuthEncryptionRootError) throw error;
      throw new OAuthFlowVerifierIntegrityError();
    }
  }

  private getKey(version: number): Promise<CryptoKey> {
    const existing = this.keys.get(version);
    if (existing) return existing;

    const derived = deriveAuthEncryptionKeyBytes(
      this.rootKeyBase64,
      "provider_pkce_flow",
      version
    ).then((bytes) =>
      crypto.subtle.importKey("raw", bytes, { name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ])
    );
    this.keys.set(version, derived);
    return derived;
  }
}
