/**
 * Codex Auth Proxy Plugin for Open-Inspect.
 *
 * Overrides the built-in CodexAuthPlugin to delegate token refresh to the
 * control plane instead of calling OpenAI directly. This ensures rotating
 * refresh tokens are persisted centrally in D1 rather than being lost when
 * ephemeral sandboxes terminate.
 *
 * Auto-loaded from .opencode/plugins/ - OpenCode discovers project plugins
 * and deduplicates by provider ID (last wins), so this replaces the built-in.
 */

import { createProviderTokenBroker } from "./provider-token-broker.js";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const MAX_REPLAY_BODY_BYTES = 16 * 1024 * 1024;
const tokenBroker = createProviderTokenBroker({ provider: "openai", providerLabel: "OpenAI" });

function replayableBody(body) {
  if (body == null) return { body: undefined };
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength <= MAX_REPLAY_BODY_BYTES ? { body } : null;
  }
  if (body instanceof URLSearchParams) {
    const value = body.toString();
    return new TextEncoder().encode(value).byteLength <= MAX_REPLAY_BODY_BYTES
      ? { body: new URLSearchParams(value) }
      : null;
  }
  if (body instanceof Blob) {
    return body.size <= MAX_REPLAY_BODY_BYTES ? { body } : null;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength <= MAX_REPLAY_BODY_BYTES ? { body: body.slice(0) } : null;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength <= MAX_REPLAY_BODY_BYTES
      ? { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice() }
      : null;
  }
  return null;
}

function requestInit(request, overrides) {
  if (!(request instanceof Request)) return { ...overrides };
  const overrideFields = { ...overrides };
  delete overrideFields.body;
  const method = overrides?.method ?? request.method;
  const body = overrides && "body" in overrides ? overrides.body : request.body;
  return {
    method,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    ...overrideFields,
    ...(method !== "GET" && method !== "HEAD" && body != null
      ? { body, duplex: request.duplex ?? "half" }
      : {}),
  };
}

const ALLOWED_MODELS = new Set([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.1-codex",
]);

async function ensureAccessToken(getAuth, setAuth, rejectedAccessToken) {
  const result = await tokenBroker.getAccessToken(async (refreshed) => {
    // Update OpenCode's auth state for consistency. The broker cache remains
    // authoritative when the local auth store cannot be updated.
    try {
      const currentAuth = await getAuth();
      const accountId = refreshed.providerMetadata?.accountId || null;
      await setAuth({
        type: "oauth",
        refresh: currentAuth?.refresh || "managed-by-control-plane",
        access: refreshed.accessToken,
        expires: refreshed.expiresAt,
        ...(accountId && { accountId }),
      });
    } catch {
      // Non-fatal: the in-memory cache is the source of truth
    }
  }, rejectedAccessToken);
  return {
    accessToken: result.accessToken,
    accountId: result.providerMetadata?.accountId || null,
  };
}

export const CodexAuthProxy = async (input) => {
  return {
    auth: {
      provider: "openai",
      methods: [],
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};

        // Filter to allowed Codex models
        for (const modelId of Object.keys(provider.models)) {
          if (!ALLOWED_MODELS.has(modelId)) {
            delete provider.models[modelId];
          }
        }

        // Inject GPT 5.3 Codex models if missing
        if (!provider.models["gpt-5.3-codex"]) {
          provider.models["gpt-5.3-codex"] = {
            name: "GPT 5.3 Codex",
            attachment: false,
            reasoning: false,
            temperature: false,
            options: {},
            variants: {},
            limit: { context: 1000000, output: 1000000 },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          };
        }

        if (!provider.models["gpt-5.3-codex-spark"]) {
          provider.models["gpt-5.3-codex-spark"] = {
            name: "GPT 5.3 Codex Spark",
            attachment: false,
            reasoning: false,
            temperature: false,
            options: {},
            variants: {},
            limit: { context: 1000000, output: 1000000 },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          };
        }

        // Zero out costs (Codex is subscription-based)
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          };
        }

        const setAuth = async (body) => {
          await input.client.auth.set({ path: { id: "openai" }, body });
        };

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput, init) {
            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth") return fetch(requestInput, init);

            // Ensure we have a valid access token
            const { accessToken, accountId } = await ensureAccessToken(getAuth, setAuth);

            // Build headers
            const sourceRequest = requestInput instanceof Request ? requestInput : null;
            const headers = new Headers(init?.headers ?? sourceRequest?.headers);
            headers.delete("authorization");

            // Set real authorization
            headers.set("authorization", `Bearer ${accessToken}`);

            // Set ChatGPT-Account-Id header
            if (accountId) {
              headers.set("ChatGPT-Account-Id", accountId);
            }

            // Rewrite URL to Codex endpoint
            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url);
            const url =
              parsed.pathname.includes("/v1/responses") ||
              parsed.pathname.includes("/chat/completions")
                ? new URL(CODEX_API_ENDPOINT)
                : parsed;

            const upstreamInit = requestInit(sourceRequest, init);
            upstreamInit.headers = headers;
            const response = await fetch(url, upstreamInit);
            if (response.status !== 401) return response;
            const replay = replayableBody(upstreamInit.body);
            if (!replay) return response;

            await response.body?.cancel();
            const refreshed = await ensureAccessToken(getAuth, setAuth, accessToken);
            const retryHeaders = new Headers(headers);
            retryHeaders.set("authorization", `Bearer ${refreshed.accessToken}`);
            if (refreshed.accountId) {
              retryHeaders.set("ChatGPT-Account-Id", refreshed.accountId);
            } else {
              retryHeaders.delete("ChatGPT-Account-Id");
            }
            return fetch(url, { ...upstreamInit, headers: retryHeaders, body: replay.body });
          },
        };
      },
    },

    "chat.headers": async (chatInput, output) => {
      if (chatInput.model.providerID !== "openai") return;
      output.headers.originator = "opencode";
      output.headers.session_id = chatInput.sessionID;
    },
  };
};
