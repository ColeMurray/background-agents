import type {
  CliDeviceAuthorizationExchangeResponse,
  PendingCliDeviceAuthorizationResponse,
} from "@open-inspect/shared/types/cli-auth";
import type { CliAuthStore } from "../db/cli-auth-store";

export const CLI_DEVICE_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;
export const CLI_CREDENTIAL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const CLI_DEVICE_ATTEMPT_RETENTION_MS = CLI_CREDENTIAL_LIFETIME_MS;
export const CLI_CREDENTIAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLI_AUTH_PRUNE_LIMIT = 100;

interface Dependencies {
  now(): number;
  generateSecret(): string;
  generateUserCode(): string;
  generateId(): string;
  hash(value: string): Promise<string>;
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
    >,
    private readonly dependencies: Dependencies
  ) {}

  async start(deviceName: string): Promise<{
    deviceSecret: string;
    userCode: string;
    expiresAt: number;
  }> {
    const now = this.dependencies.now();
    const deviceSecret = this.dependencies.generateSecret();
    const userCode = this.dependencies.generateUserCode();
    const expiresAt = now + CLI_DEVICE_AUTHORIZATION_LIFETIME_MS;
    await this.store.pruneExpired({
      now,
      attemptRetentionMs: CLI_DEVICE_ATTEMPT_RETENTION_MS,
      credentialRetentionMs: CLI_CREDENTIAL_RETENTION_MS,
      limit: CLI_AUTH_PRUNE_LIMIT,
    });
    await this.store.createAttempt({
      id: this.dependencies.generateId(),
      deviceName,
      deviceSecretHash: await this.dependencies.hash(deviceSecret),
      userCodeHash: await this.dependencies.hash(userCode),
      createdAt: now,
      expiresAt,
    });
    return { deviceSecret, userCode, expiresAt };
  }

  async getPendingAuthorization(userCode: string): Promise<PendingCliDeviceAuthorizationResponse> {
    const outcome = await this.store.getPendingAuthorization(
      await this.dependencies.hash(userCode),
      this.dependencies.now()
    );
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
    const outcome = await this.store.approve(
      await this.dependencies.hash(userCode),
      userId,
      this.dependencies.now()
    );
    if (outcome === "approved") return;
    if (outcome === "expired") throw new CliDeviceAuthorizationError("Authorization expired", 410);
    if (outcome === "not_found")
      throw new CliDeviceAuthorizationError("Authorization not found", 404);
    throw new CliDeviceAuthorizationError("Authorization is no longer available", 409);
  }

  async exchange(deviceSecret: string): Promise<CliDeviceAuthorizationExchangeResponse> {
    const now = this.dependencies.now();
    const credentialId = this.dependencies.generateId();
    const claimId = this.dependencies.generateId();
    const credential = `oi_cli_${this.dependencies.generateSecret()}`;
    const expiresAt = now + CLI_CREDENTIAL_LIFETIME_MS;
    const outcome = await this.store.exchangeApprovedAttempt({
      deviceSecretHash: await this.dependencies.hash(deviceSecret),
      claimId,
      credentialId,
      credentialHash: await this.dependencies.hash(credential),
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
      await this.dependencies.hash(deviceSecret),
      this.dependencies.now()
    );
  }
}
