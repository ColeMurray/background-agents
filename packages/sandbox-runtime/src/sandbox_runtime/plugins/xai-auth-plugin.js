/**
 * xAI Auth Proxy Plugin for Open-Inspect.
 *
 * Keeps rotating SuperGrok refresh tokens in the control plane while exposing
 * only short-lived access tokens to the ephemeral sandbox.
 */

const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedAccessToken = null;
let cachedExpiresAt = 0;
let refreshPromise = null;

function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    return config.sessionId || config.session_id || "";
  } catch {
    return "";
  }
}

async function refreshViaControlPlane() {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
  const authToken = process.env.SANDBOX_AUTH_TOKEN;
  const sessionId = getSessionId();
  if (!controlPlaneUrl || !authToken || !sessionId) {
    throw new Error("Missing environment for xAI token refresh");
  }

  const response = await fetch(`${controlPlaneUrl}/sessions/${sessionId}/xai-token-refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`xAI token refresh failed (${response.status}): ${body}`);
  }
  return response.json();
}

async function ensureAccessToken() {
  if (cachedAccessToken && cachedExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return cachedAccessToken;
  }
  if (!refreshPromise) {
    refreshPromise = refreshViaControlPlane()
      .then((result) => {
        cachedAccessToken = result.access_token;
        cachedExpiresAt = Date.now() + (result.expires_in ?? 3600) * 1000;
        return cachedAccessToken;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export const XaiAuthProxy = async () => ({
  provider: {
    id: "xai",
    async models(provider) {
      if (provider.models["grok-build-0.1"]) return provider.models;
      const base =
        provider.models["grok-code-fast-1"] ||
        Object.values(provider.models).find((model) => model.capabilities.reasoning);
      if (!base) throw new Error("xAI catalog has no reasoning model to seed Grok Build metadata");
      return {
        ...provider.models,
        "grok-build-0.1": {
          ...base,
          id: "grok-build-0.1",
          providerID: "xai",
          api: { ...base.api, id: "grok-build-0.1" },
          name: "Grok Build 0.1",
          status: "active",
          options: {},
          headers: {},
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          variants: {
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
          },
        },
      };
    },
  },
  auth: {
    provider: "xai",
    methods: [],
    async loader(getAuth) {
      const auth = await getAuth();
      if (auth.type !== "oauth") return {};
      return {
        apiKey: OAUTH_DUMMY_KEY,
        async fetch(requestInput, init) {
          const currentAuth = await getAuth();
          if (currentAuth.type !== "oauth") return fetch(requestInput, init);
          const headers = new Headers(
            requestInput instanceof Request ? requestInput.headers : undefined
          );
          if (init?.headers) {
            const entries =
              init.headers instanceof Headers
                ? init.headers.entries()
                : Array.isArray(init.headers)
                  ? init.headers
                  : Object.entries(init.headers);
            for (const [key, value] of entries) {
              if (value !== undefined) headers.set(key, String(value));
            }
          }
          headers.set("authorization", `Bearer ${await ensureAccessToken()}`);
          return fetch(requestInput, { ...init, headers });
        },
      };
    },
  },
});
