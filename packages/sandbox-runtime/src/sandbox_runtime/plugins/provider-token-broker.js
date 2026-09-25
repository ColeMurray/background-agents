const REFRESH_BUFFER_MS = 5 * 60 * 1000;
import { writeFile } from "node:fs/promises";
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    return config.sessionId || config.session_id || "";
  } catch {
    return "";
  }
}

function validateBrokerResponse(result, providerLabel) {
  if (
    !result ||
    typeof result.accessToken !== "string" ||
    !result.accessToken.trim() ||
    (result.expiresIn !== undefined &&
      (typeof result.expiresIn !== "number" ||
        !Number.isFinite(result.expiresIn) ||
        result.expiresIn <= 0))
  ) {
    throw new Error(`Invalid ${providerLabel} token broker response`);
  }
}

/**
 * Create a provider-neutral, single-flight client for the session token broker.
 * Each auth plugin owns one instance, so cached credentials never cross providers.
 */
export function createProviderTokenBroker({ provider, providerLabel }) {
  const switchIdentity = JSON.parse(process.env.PROVIDER_ACCOUNT_SWITCH_IDENTITY || "null");
  let expected = switchIdentity?.provider === provider ? switchIdentity : null;
  let cachedResult = null;
  let cachedExpiresAt = 0;
  let refreshPromise = null;

  async function refresh(onRefresh) {
    const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
    const authToken = process.env.SANDBOX_AUTH_TOKEN;
    const sessionId = getSessionId();
    if (!controlPlaneUrl || !authToken || !sessionId) {
      throw new Error(`Missing environment for ${providerLabel} token refresh`);
    }

    const requestToken = () =>
      fetch(`${controlPlaneUrl}/sessions/${sessionId}/provider-auth/${provider}/access-token`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          ...(expected ? { "x-provider-binding-revision": String(expected.bindingRevision) } : {}),
        },
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    let response = await requestToken();
    if (response.status === 409 && !expected) {
      const stale = await response
        .clone()
        .json()
        .catch(() => null);
      if (stale?.error === "stale_provider_binding") {
        const binding = await fetch(
          `${controlPlaneUrl}/sessions/${sessionId}/provider-auth/${provider}/binding`,
          {
            headers: { Authorization: `Bearer ${authToken}` },
            signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
          }
        );
        if (!binding.ok) throw new Error("Provider binding unavailable");
        const discovered = await binding.json();
        if (
          !Number.isSafeInteger(discovered.bindingRevision) ||
          discovered.bindingRevision < 1 ||
          typeof discovered.providerAccountId !== "string" ||
          !discovered.providerAccountId ||
          typeof discovered.generation?.sandboxId !== "string" ||
          !discovered.generation.sandboxId ||
          !Number.isSafeInteger(discovered.generation?.createdAt) ||
          discovered.generation.createdAt <= 0
        ) {
          throw new Error("Invalid provider binding response");
        }
        expected = discovered;
        response = await requestToken();
      }
    }
    if (!response.ok) {
      throw new Error(`${providerLabel} token refresh failed (${response.status})`);
    }

    const result = await response.json();
    validateBrokerResponse(result, providerLabel);
    if (
      expected &&
      (result.bindingRevision !== expected.bindingRevision ||
        (expected.providerAccountId && result.providerAccountId !== expected.providerAccountId) ||
        result.generation?.sandboxId !== expected.generation?.sandboxId ||
        result.generation?.createdAt !== expected.generation?.createdAt)
    ) {
      throw new Error("Stale provider credential response");
    }
    cachedResult = result;
    cachedExpiresAt = Date.now() + (result.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
    await onRefresh?.({ ...result, expiresAt: cachedExpiresAt });
    if (switchIdentity?.provider === provider) {
      await writeFile(
        `/tmp/provider-account-proof-${provider}.json`,
        JSON.stringify(switchIdentity),
        { mode: 0o600 }
      );
    }
    return { ...result, expiresAt: cachedExpiresAt };
  }

  return {
    async prepareSwitch() {
      if (switchIdentity?.provider === provider) await this.getAccessToken();
    },
    async getAccessToken(onRefresh) {
      if (cachedResult && cachedExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
        return { ...cachedResult, expiresAt: cachedExpiresAt };
      }
      if (!refreshPromise) {
        refreshPromise = refresh(onRefresh).finally(() => {
          refreshPromise = null;
        });
      }
      return refreshPromise;
    },
  };
}
