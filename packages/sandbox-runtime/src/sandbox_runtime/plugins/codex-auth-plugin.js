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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createProviderTokenBroker } from "./provider-token-broker.js";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const tokenBroker = createProviderTokenBroker({ provider: "openai", providerLabel: "OpenAI" });

const DEFAULT_MODELS_URL = "https://models.opencode.ai";
const validRate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Mirror OpenCode's models.dev cost conversion. These are model-price
// equivalents, not charges incurred by a ChatGPT subscription.
function catalogCost(raw) {
  if (!raw || !validRate(raw.input) || !validRate(raw.output)) return null;
  const convert = (cost) => ({
    input: cost.input,
    output: cost.output,
    cache: {
      read: validRate(cost.cache_read) ? cost.cache_read : 0,
      write: validRate(cost.cache_write) ? cost.cache_write : 0,
    },
  });
  const result = convert(raw);
  if (Array.isArray(raw.tiers)) {
    result.tiers = raw.tiers
      .filter(
        (tier) =>
          validRate(tier?.input) &&
          validRate(tier?.output) &&
          tier.tier?.type === "context" &&
          validRate(tier.tier.size)
      )
      .map((tier) => ({ ...convert(tier), tier: tier.tier }));
  }
  if (validRate(raw.context_over_200k?.input) && validRate(raw.context_over_200k?.output)) {
    result.experimentalOver200K = convert(raw.context_over_200k);
  }
  return result;
}

async function openAiCatalogModels() {
  const source = process.env.OPENCODE_MODELS_URL || DEFAULT_MODELS_URL;
  // Matches ModelsDev.Service in pinned OpenCode 1.18.29; our image refreshes this cache.
  const cachePath =
    process.env.OPENCODE_MODELS_PATH ||
    (source === DEFAULT_MODELS_URL
      ? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json")
      : null);
  if (!cachePath) {
    console.warn(
      "OpenCode model prices unavailable; set OPENCODE_MODELS_PATH for a custom catalog"
    );
    return null;
  }
  try {
    const catalog = JSON.parse(await readFile(cachePath, "utf8"));
    const models = catalog?.openai?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) {
      throw new Error("OpenAI models missing from cached catalog");
    }
    return models;
  } catch (error) {
    console.warn(
      "OpenCode model prices unavailable in cache; leaving OAuth model costs at zero",
      error
    );
    return null;
  }
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
        const catalog = await openAiCatalogModels();
        // The built-in hook filters models and zeroes OAuth prices first.
        const models = Object.fromEntries(
          Object.entries(provider.models)
            .filter(([modelId]) => ALLOWED_MODELS.has(modelId))
            .map(([modelId, model]) => {
              const cost = catalogCost(catalog?.[modelId]?.cost);
              return [modelId, cost ? { ...model, cost } : model];
            })
        );
        return models;
      },
    },
    auth: {
      provider: "openai",
      methods: [],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};

        const setAuth = async (body) => {
          await input.client.auth.set({ path: { id: "openai" }, body });
        };

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput, init) {
            const request = new Request(requestInput, init);

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth") return fetch(request);

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

            // Let OpenCode's stream timeout handle stalls instead of Bun's fetch idle timer.
            return fetch(proxiedRequest, { timeout: false });
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
