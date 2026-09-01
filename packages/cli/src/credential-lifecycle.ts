import { ApiClient, ApiError } from "./api-client.js";
import type {
  ConfigStore,
  IssuedContext,
  NamedContext,
  PendingDeviceAuthorization,
  PendingRevocation,
  StoredContext,
} from "./config-store.js";
import { CliError, withErrorContext } from "./errors.js";

const DEFINITIVELY_INVALID_STATUSES = new Set([401, 404, 410]);

/** Coordinates remote credential revocation with committed local context bindings. */
export class CredentialLifecycle {
  constructor(
    private readonly store: ConfigStore,
    private readonly fetch?: typeof globalThis.fetch
  ) {}

  async prepareLogin(): Promise<void> {
    const deviceAuthorizations = await this.drainDeviceAuthorizations();
    const credentials = await this.drainPendingCredentials();
    const failures = [...deviceAuthorizations.failures, ...credentials.failures];
    if (failures.length) throw revocationFailure(failures);
  }

  stageDeviceAuthorization(input: {
    url: string;
    contextName: string;
    deviceSecret: string;
  }): Promise<string> {
    return this.store.stageDeviceAuthorization(input);
  }

  async install(
    name: string,
    context: IssuedContext,
    deviceSecretRef: string
  ): Promise<{ pendingRevocations: number; pendingDeviceAuthorizations: number }> {
    let staged;
    try {
      staged = await this.store.stageCredential(context);
    } catch (cause) {
      const failures = [cause];
      try {
        await this.revoke(context);
      } catch (revokeCause) {
        if (!isDefinitivelyInvalid(revokeCause)) failures.push(revokeCause);
      }
      const recovered = await this.drainDeviceAuthorizations();
      throw revocationFailure([...failures, ...recovered.failures]);
    }
    try {
      await this.store.promoteStagedContext(name, staged, deviceSecretRef);
    } catch (cause) {
      const credentials = await this.drainPendingCredentials();
      const deviceAuthorizations = await this.drainDeviceAuthorizations();
      const failure = withErrorContext(cause, {
        credentialId: context.credentialId,
        credentialRef: staged.credentialRef,
      });
      throw revocationFailure([failure, ...credentials.failures, ...deviceAuthorizations.failures]);
    }

    const deviceAuthorizations = await this.drainDeviceAuthorizations();
    const credentials = await this.drainPendingCredentials();
    return {
      pendingRevocations: credentials.remaining,
      pendingDeviceAuthorizations: deviceAuthorizations.remaining,
    };
  }

  async logout(): Promise<
    NamedContext & {
      remoteRevocationComplete: boolean;
      pendingRevocations: number;
      pendingDeviceAuthorizations: number;
    }
  > {
    let removed: NamedContext;
    try {
      removed = await this.store.removeActiveContext();
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.kind !== "auth") throw cause;
      await this.drainDeviceAuthorizations();
      await this.drainPendingCredentials();
      throw cause;
    }
    const deviceAuthorizations = await this.drainDeviceAuthorizations();
    const credentials = await this.drainPendingCredentials();
    let activeRevoked = true;
    try {
      await this.revoke(removed);
    } catch (cause) {
      activeRevoked = isDefinitivelyInvalid(cause);
    }
    return {
      ...removed,
      remoteRevocationComplete:
        activeRevoked &&
        credentials.failures.length === 0 &&
        deviceAuthorizations.failures.length === 0,
      pendingRevocations: credentials.remaining,
      pendingDeviceAuthorizations: deviceAuthorizations.remaining,
    };
  }

  private async drainPendingCredentials(): Promise<{
    remaining: number;
    failures: unknown[];
  }> {
    let pending: PendingRevocation[];
    try {
      pending = await this.store.getPendingRevocations();
    } catch (cause) {
      return { remaining: 0, failures: [cause] };
    }
    let remaining = pending.length;
    const failures: unknown[] = [];
    for (const credential of pending) {
      if (!credential.credential) {
        try {
          await this.store.completePendingRevocation(credential.credentialRef);
          remaining -= 1;
        } catch (cause) {
          failures.push(cause);
        }
        continue;
      }
      try {
        await this.revoke({ url: credential.url, credential: credential.credential });
      } catch (cause) {
        if (!isDefinitivelyInvalid(cause)) {
          failures.push(cause);
          continue;
        }
      }
      try {
        await this.store.completePendingRevocation(credential.credentialRef);
        remaining -= 1;
      } catch (cause) {
        failures.push(cause);
      }
    }
    return { remaining, failures };
  }

  private async drainDeviceAuthorizations(): Promise<{
    remaining: number;
    failures: unknown[];
  }> {
    let pending: PendingDeviceAuthorization[];
    try {
      pending = await this.store.getPendingDeviceAuthorizations();
    } catch (cause) {
      return { remaining: 0, failures: [cause] };
    }
    let remaining = pending.length;
    const failures: unknown[] = [];
    for (const authorization of pending) {
      if (authorization.state === "recovery") {
        if (!authorization.deviceSecret) {
          try {
            await this.store.completePendingDeviceAuthorization(authorization.deviceSecretRef);
            remaining -= 1;
          } catch (cause) {
            failures.push(cause);
          }
          continue;
        }
        try {
          await this.revokeDeviceAuthorization(authorization.url, authorization.deviceSecret);
        } catch (cause) {
          failures.push(cause);
          continue;
        }
      }
      try {
        await this.store.completePendingDeviceAuthorization(authorization.deviceSecretRef);
        remaining -= 1;
      } catch (cause) {
        failures.push(cause);
      }
    }
    return { remaining, failures };
  }

  private revoke(context: Pick<StoredContext, "url" | "credential">): Promise<void> {
    return new ApiClient({
      baseUrl: context.url,
      fetch: this.fetch,
      authorize: () => Promise.resolve(context.credential),
    }).revokeCredential();
  }

  private revokeDeviceAuthorization(url: string, deviceSecret: string): Promise<void> {
    return new ApiClient({ baseUrl: url, fetch: this.fetch }).revokeDeviceAuthorization(
      deviceSecret
    );
  }
}

function revocationFailure(failures: unknown[]): unknown {
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, "Credential recovery failed and remains retryable");
}

function isDefinitivelyInvalid(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    cause.status !== undefined &&
    DEFINITIVELY_INVALID_STATUSES.has(cause.status)
  );
}
