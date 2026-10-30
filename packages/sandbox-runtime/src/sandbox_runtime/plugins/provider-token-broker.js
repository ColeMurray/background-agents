export class ProviderTokenBrokerError extends Error {
  constructor(message, { kind, status = null, providerCode = null }) {
    super(message);
    this.name = "ProviderTokenBrokerError";
    this.kind = kind;
    this.status = status;
    /**
     * The control plane's own error code when it sent one. An HTTP status
     * cannot separate a credential that needs reconnection from transient
     * exchange contention — both answer 409 — so callers deciding whether to
     * abandon a subscription must read this instead.
     */
    this.providerCode = providerCode;
  }
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
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
    throw new ProviderTokenBrokerError(`Invalid ${providerLabel} token broker response`, {
      kind: "invalid_response",
    });
  }
}

/**
 * Create a provider-neutral, single-flight client for the session token broker.
 * Each auth plugin owns one instance, so cached credentials never cross providers.
 */
export function createProviderTokenBroker({ provider, providerLabel }) {
  let cachedResult = null;
  let cachedExpiresAt = 0;
  let refreshPromise = null;

  async function refresh(onRefresh) {
    const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
    const authToken = process.env.SANDBOX_AUTH_TOKEN;
    const sessionId = getSessionId();
    if (!controlPlaneUrl || !authToken || !sessionId) {
      throw new ProviderTokenBrokerError(`Missing environment for ${providerLabel} token refresh`, {
        kind: "configuration",
      });
    }

    const response = await fetch(
      `${controlPlaneUrl}/sessions/${sessionId}/provider-auth/${provider}/access-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      const raw = (await response.text()).slice(0, 200);
      let providerCode = null;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.code === "string" && parsed.code) providerCode = parsed.code;
      } catch {
        // A non-JSON body carries no code; the status still classifies it.
      }
      throw new ProviderTokenBrokerError(
        `${providerLabel} token refresh failed (${response.status}): ${raw}`,
        { kind: "http", status: response.status, providerCode }
      );
    }

    const result = await response.json();
    validateBrokerResponse(result, providerLabel);
    cachedResult = result;
    cachedExpiresAt = Date.now() + (result.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
    await onRefresh?.({ ...result, expiresAt: cachedExpiresAt });
    return { ...result, expiresAt: cachedExpiresAt };
  }

  return {
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
