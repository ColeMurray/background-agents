import type {
  CliDeviceAuthorizationExchangeResponse,
  PendingCliDeviceAuthorizationResponse,
} from "@open-inspect/shared/types/cli-auth";
import { generateId, hashToken } from "../auth/crypto";
import type { CliAuthStore } from "../db/cli-auth-store";

export const CLI_DEVICE_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;
export const CLI_CREDENTIAL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const CLI_DEVICE_ATTEMPT_RETENTION_MS = CLI_CREDENTIAL_LIFETIME_MS;
export const CLI_CREDENTIAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLI_AUTH_PRUNE_LIMIT = 100;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(
    bytes,
    (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
  ).join("");
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class CliDeviceAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "CliDeviceAuthorizationError";
  }
}

/** Coordinates hash-only, single-use CLI device authorization and credential issuance. */
export class CliDeviceAuthorizationService {
  constructor(
    private readonly store: Pick<
      CliAuthStore,
      | "createAttempt"
      | "approve"
      | "exchangeApprovedAttempt"
      | "getPendingAuthorization"
      | "pruneExpired"
      | "revokeIssuedCredentialByDeviceSecret"
    >
  ) {}

  async start(deviceName: string): Promise<{
    deviceSecret: string;
    userCode: string;
    expiresAt: number;
  }> {
    const now = Date.now();
    const deviceSecret = generateId(32);
    const userCode = generateUserCode();
    const expiresAt = now + CLI_DEVICE_AUTHORIZATION_LIFETIME_MS;
    await this.store.pruneExpired({
      now,
      attemptRetentionMs: CLI_DEVICE_ATTEMPT_RETENTION_MS,
      credentialRetentionMs: CLI_CREDENTIAL_RETENTION_MS,
      limit: CLI_AUTH_PRUNE_LIMIT,
    });
    await this.store.createAttempt({
      id: generateId(),
      deviceName,
      deviceSecretHash: await hashToken(deviceSecret),
      userCodeHash: await hashToken(userCode),
      createdAt: now,
      expiresAt,
    });
    return { deviceSecret, userCode, expiresAt };
  }

  async getPendingAuthorization(
    userCode: string
  ): Promise<Omit<PendingCliDeviceAuthorizationResponse, "installation">> {
    const outcome = await this.store.getPendingAuthorization(await hashToken(userCode), Date.now());
    if (outcome.status === "pending") {
      return { deviceName: outcome.deviceName, expiresAt: outcome.expiresAt };
    }
    if (outcome.status === "expired") {
      throw new CliDeviceAuthorizationError("Authorization expired", 410);
    }
    if (outcome.status === "not_found") {
      throw new CliDeviceAuthorizationError("Authorization not found", 404);
    }
    throw new CliDeviceAuthorizationError("Authorization is no longer available", 409);
  }

  async approve(userCode: string, userId: string): Promise<void> {
    const outcome = await this.store.approve(await hashToken(userCode), userId, Date.now());
    if (outcome === "approved") return;
    if (outcome === "expired") throw new CliDeviceAuthorizationError("Authorization expired", 410);
    if (outcome === "not_found")
      throw new CliDeviceAuthorizationError("Authorization not found", 404);
    throw new CliDeviceAuthorizationError("Authorization is no longer available", 409);
  }

  async exchange(deviceSecret: string): Promise<CliDeviceAuthorizationExchangeResponse> {
    const now = Date.now();
    const credentialId = generateId();
    const claimId = generateId();
    const credential = `oi_cli_${generateId(32)}`;
    const expiresAt = now + CLI_CREDENTIAL_LIFETIME_MS;
    const outcome = await this.store.exchangeApprovedAttempt({
      deviceSecretHash: await hashToken(deviceSecret),
      claimId,
      credentialId,
      credentialHash: await hashToken(credential),
      now,
      credentialExpiresAt: expiresAt,
    });
    if (outcome.status === "issued") {
      return { status: "authorized", credential, credentialId, expiresAt };
    }
    if (outcome.status === "pending") return outcome;
    if (outcome.status === "not_found") {
      throw new CliDeviceAuthorizationError("Authorization not found", 404);
    }
    throw new CliDeviceAuthorizationError("Authorization is no longer available", 410);
  }

  async revokeIssuedCredential(deviceSecret: string): Promise<void> {
    await this.store.revokeIssuedCredentialByDeviceSecret(
      await hashToken(deviceSecret),
      Date.now()
    );
  }
}
