/**
 * Codex Auth Proxy Plugin for Open-Inspect.
 *
 * Overrides the built-in CodexAuthPlugin to delegate token refresh to the
 * control plane instead of calling OpenAI directly. This ensures rotating
 * refresh tokens are persisted centrally in D1 rather than being lost when
 * ephemeral sandboxes terminate.
 *
 * Auto-loaded from .opencode/plugins/. OpenCode runs the built-in model hook
 * first, then this hook; our auth loader brokers the managed credential.
 */

import { createProviderTokenBroker } from "./provider-token-broker.js";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const tokenBroker = createProviderTokenBroker({ provider: "openai", providerLabel: "OpenAI" });

// API-list-price equivalents, USD per million tokens. Snapshot of
// https://models.dev/api.json (openai models, 2026-09-27); these are not
// ChatGPT subscription charges. Supported models without a listed price
// remain unpriced.
const price = ({ input, output, cache_read, cache_write = 0, context_over_200k }) => {
  const base = { input, output, cache: { read: cache_read, write: cache_write } };
  if (!context_over_200k) return base;
  const elevated = price(context_over_200k);
  return {
    ...base,
    experimentalOver200K: elevated,
    tiers: [{ ...elevated, tier: { type: "context", size: 272_000 } }],
  };
};

export const API_EQUIVALENT_PRICES = {
  "gpt-5.3-codex": price({ input: 1.75, output: 14, cache_read: 0.175 }),
  "gpt-5.3-codex-spark": price({ input: 1.75, output: 14, cache_read: 0.175 }),
  "gpt-5.4": price({
    input: 2.5,
    output: 15,
    cache_read: 0.25,
    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
  }),
  "gpt-5.5": price({
    input: 5,
    output: 30,
    cache_read: 0.5,
    context_over_200k: { input: 10, output: 45, cache_read: 1 },
  }),
  "gpt-5.6-sol": price({
    input: 4,
    output: 20,
    cache_read: 0.4,
    cache_write: 5,
    context_over_200k: { input: 8, output: 30, cache_read: 0.8, cache_write: 10 },
  }),
  "gpt-5.6-terra": price({
    input: 2,
    output: 12,
    cache_read: 0.2,
    cache_write: 2.5,
    context_over_200k: { input: 4, output: 18, cache_read: 0.4, cache_write: 5 },
  }),
  "gpt-5.6-luna": price({
    input: 0.2,
    output: 1.2,
    cache_read: 0.02,
    cache_write: 0.25,
    context_over_200k: { input: 0.4, output: 1.8, cache_read: 0.04, cache_write: 0.5 },
  }),
  "gpt-6-astra": price({
    input: 10,
    output: 50,
    cache_read: 1,
    cache_write: 12.5,
    context_over_200k: { input: 20, output: 75, cache_read: 2, cache_write: 25 },
  }),
  "gpt-6-sol": price({
    input: 2,
    output: 10,
    cache_read: 0.2,
    cache_write: 2.5,
    context_over_200k: { input: 4, output: 15, cache_read: 0.4, cache_write: 5 },
  }),
  "gpt-6-luna": price({
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_write: 0.125,
    context_over_200k: { input: 0.2, output: 0.75, cache_read: 0.02, cache_write: 0.25 },
  }),
};

const CODEX_53_MODELS = {
  "gpt-5.3-codex": {
    name: "GPT-5.3 Codex",
    family: "gpt-codex",
    temperature: true,
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  },
  "gpt-5.3-codex-spark": {
    name: "GPT-5.3 Codex Spark",
    family: "gpt-codex-spark",
    temperature: false,
    limit: { context: 128_000, input: 100_000, output: 32_000 },
  },
};

function injectedCodexModel(modelId, details) {
  return {
    id: modelId,
    providerID: "openai",
    api: { id: modelId, url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    name: details.name,
    family: details.family,
    capabilities: {
      temperature: details.temperature,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: API_EQUIVALENT_PRICES[modelId],
    limit: details.limit,
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-02-05",
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
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.1-codex",
]);

async function ensureAccessToken(getAuth, setAuth) {
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
  });
  return {
    accessToken: result.accessToken,
    accountId: result.providerMetadata?.accountId || null,
  };
}

export const CodexAuthProxy = async (input) => {
  return {
    provider: {
      id: "openai",
      async models(provider, context) {
        if (context.auth?.type !== "oauth") return provider.models;
        // The built-in hook filters models and zeroes OAuth prices first.
        const models = Object.fromEntries(
          Object.entries(provider.models)
            .filter(([modelId]) => ALLOWED_MODELS.has(modelId))
            .map(([modelId, model]) => [
              modelId,
              API_EQUIVALENT_PRICES[modelId]
                ? { ...model, cost: API_EQUIVALENT_PRICES[modelId] }
                : model,
            ])
        );
        for (const [modelId, details] of Object.entries(CODEX_53_MODELS)) {
          if (!models[modelId]) models[modelId] = injectedCodexModel(modelId, details);
        }
        return models;
      },
    },
    auth: {
      provider: "openai",
      methods: [],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth.type !== "oauth") {
          throw new Error("Managed OpenAI authentication changed away from OAuth");
        }

        const setAuth = async (body) => {
          await input.client.auth.set({ path: { id: "openai" }, body });
        };

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput, init) {
            const request = new Request(requestInput, init);

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth") {
              throw new Error("Managed OpenAI authentication changed away from OAuth");
            }

            request.headers.delete("authorization");

            // Ensure we have a valid access token
            const { accessToken, accountId } = await ensureAccessToken(getAuth, setAuth);

            const parsed = new URL(request.url);
            const url =
              parsed.pathname.includes("/v1/responses") ||
              parsed.pathname.includes("/chat/completions")
                ? new URL(CODEX_API_ENDPOINT)
                : parsed;
            const proxiedRequest = new Request(url, request);

            // Replace the dummy API key without discarding source Request options.
            proxiedRequest.headers.set("authorization", `Bearer ${accessToken}`);
            if (accountId) proxiedRequest.headers.set("ChatGPT-Account-Id", accountId);

            return fetch(proxiedRequest);
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
