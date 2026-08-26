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
    throw new Error(`Invalid ${providerLabel} token broker response`);
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
      throw new Error(`Missing environment for ${providerLabel} token refresh`);
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
      const body = (await response.text()).slice(0, 200);
      throw new Error(`${providerLabel} token refresh failed (${response.status}): ${body}`);
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
