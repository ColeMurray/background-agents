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

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_API_ENDPOINT = "https://api.openai.com/v1/responses";
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

/**
 * Optional per-token key used only once the ChatGPT subscription cannot serve a
 * request. Deliberately not named OPENAI_API_KEY: that name switches the whole
 * deployment to metered billing (the control plane then never enables broker
 * mode), whereas this one keeps the subscription first and spills over.
 */
const FALLBACK_KEY_ENV = "OPENAI_API_KEY_FALLBACK";

/**
 * Percentage of a subscription rate-limit window this sandbox may consume before
 * spilling over. Defaults to 100 (spend the window, then switch). Lower values
 * reserve headroom for whoever else uses the same ChatGPT account.
 */
const MAX_PERCENT_ENV = "OPENAI_SUBSCRIPTION_MAX_PERCENT";

/** Reads window usage without consuming any of it. */
const USAGE_STATUS_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_PROBE_TIMEOUT_MS = 5000;

/** Headers the ChatGPT backend expects that api.openai.com has no use for. */
const CHATGPT_ONLY_HEADERS = ["chatgpt-account-id", "originator", "session_id"];

/** Response headers that describe the transport, not the payload. */
const TRANSPORT_HEADERS = ["content-encoding", "content-length"];

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

// In-memory token cache (reset on sandbox restart - fresh refresh via bridge)
let cachedAccessToken = null;
let cachedAccountId = null;
let cachedExpiresAt = 0;

// Latched for the rest of the sandbox's life once the subscription is spent, so
// a doomed Codex call is not repeated on every later turn.
let spilloverLatched = false;

// One usage probe per sandbox: afterwards every Codex response carries the
// numbers in its headers for free.
let usageProbed = false;

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
    throw new Error(
      "Missing environment for token refresh: " +
        [
          !controlPlaneUrl && "CONTROL_PLANE_URL",
          !authToken && "SANDBOX_AUTH_TOKEN",
          !sessionId && "SESSION_CONFIG.sessionId",
        ]
          .filter(Boolean)
          .join(", ")
    );
  }

  const response = await fetch(`${controlPlaneUrl}/sessions/${sessionId}/openai-token-refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function ensureAccessToken(getAuth, setAuth) {
  const now = Date.now();

  // Return cached token if still fresh
  if (cachedAccessToken && cachedExpiresAt - now > REFRESH_BUFFER_MS) {
    return { accessToken: cachedAccessToken, accountId: cachedAccountId };
  }

  // Refresh via control plane
  const result = await refreshViaControlPlane();

  cachedAccessToken = result.access_token;
  cachedAccountId = result.account_id || null;
  cachedExpiresAt = now + (result.expires_in ?? 3600) * 1000;

  // Update OpenCode's auth state for consistency
  try {
    const currentAuth = await getAuth();
    await setAuth({
      type: "oauth",
      refresh: currentAuth?.refresh || "managed-by-control-plane",
      access: result.access_token,
      expires: cachedExpiresAt,
      ...(cachedAccountId && { accountId: cachedAccountId }),
    });
  } catch {
    // Non-fatal: the in-memory cache is the source of truth
  }

  return { accessToken: cachedAccessToken, accountId: cachedAccountId };
}

function headersFrom(init) {
  const headers = new Headers();
  if (!init?.headers) return headers;
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => headers.set(key, value));
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (value !== undefined) headers.set(key, String(value));
    }
  } else {
    for (const [key, value] of Object.entries(init.headers)) {
      if (value !== undefined) headers.set(key, String(value));
    }
  }
  return headers;
}

function isModelRequest(url) {
  return url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions");
}

function toPercent(value) {
  const percent = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(percent) ? percent : null;
}

/** The configured share of a subscription window this sandbox may consume. */
function subscriptionMaxPercent() {
  const raw = process.env[MAX_PERCENT_ENV];
  if (!raw) return 100;
  const percent = toPercent(raw);
  if (percent === null || percent <= 0 || percent > 100) {
    console.error(
      `[codex-auth-plugin] ignoring ${MAX_PERCENT_ENV}="${raw}": expected a percentage in (0, 100]`
    );
    return 100;
  }
  return percent;
}

/** Highest window usage Codex reported on a response, or null when absent. */
function usedPercentFromHeaders(headers) {
  let highest = null;
  for (const window of ["primary", "secondary"]) {
    const used = toPercent(headers.get(`x-codex-${window}-used-percent`));
    if (used !== null) highest = Math.max(highest ?? 0, used);
  }
  return highest;
}

/**
 * Why the subscription can no longer serve this request, or null to keep using
 * it. Codex reports usage through its own header family (x-codex-*) rather than
 * the standard x-ratelimit-* headers.
 */
function spentReason(response, { maxPercent = 100, bodyText = "" } = {}) {
  const reached = response.headers.get("x-codex-rate-limit-reached-type");
  if (reached) return `Codex reported the ${reached} limit reached`;
  const used = usedPercentFromHeaders(response.headers);
  if (used !== null && used >= maxPercent) {
    return `subscription usage at ${used}% of the ${maxPercent}% ceiling`;
  }
  if (/usage limit|quota/i.test(bodyText)) {
    return "the ChatGPT subscription reported its usage limit";
  }
  return null;
}

/**
 * Reads the account's window usage from the ChatGPT usage endpoint, which does
 * not consume any of it. Returns the highest window, or null when the payload
 * carries no usage at all.
 */
async function probeUsedPercent(accessToken, accountId) {
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    originator: "opencode",
  });
  if (accountId) headers.set("ChatGPT-Account-Id", accountId);

  const response = await fetch(USAGE_STATUS_ENDPOINT, {
    headers,
    signal: AbortSignal.timeout(USAGE_PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`usage status ${response.status}`);

  const rateLimit = (await response.json())?.rate_limit;
  if (rateLimit?.limit_reached) return 100;
  let highest = null;
  for (const window of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    const used = toPercent(window?.used_percent);
    if (used !== null) highest = Math.max(highest ?? 0, used);
  }
  return highest;
}

function spilloverHeaders(headers, apiKey) {
  const next = new Headers(headers);
  for (const name of CHATGPT_ONLY_HEADERS) next.delete(name);
  next.set("authorization", `Bearer ${apiKey}`);
  return next;
}

/** Re-materialize a response whose body was read to classify a 429. */
function replayResponse(response, bodyText) {
  const headers = new Headers(response.headers);
  for (const name of TRANSPORT_HEADERS) headers.delete(name);
  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function latchSpillover(reason) {
  if (spilloverLatched) return;
  spilloverLatched = true;
  console.error(
    `[codex-auth-plugin] spilling OpenAI traffic over to ${FALLBACK_KEY_ENV}: ${reason}`
  );
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
            // Remove dummy API key authorization header
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
                init.headers.delete("Authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization"
                );
              } else {
                delete init.headers["authorization"];
                delete init.headers["Authorization"];
              }
            }

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth") return fetch(requestInput, init);

            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url);
            const headers = headersFrom(init);
            const modelRequest = isModelRequest(parsed);
            const fallbackKey = (modelRequest && process.env[FALLBACK_KEY_ENV]) || "";

            if (fallbackKey && spilloverLatched) {
              return fetch(OPENAI_API_ENDPOINT, {
                ...init,
                headers: spilloverHeaders(headers, fallbackKey),
              });
            }

            let accessToken;
            let accountId;
            try {
              ({ accessToken, accountId } = await ensureAccessToken(getAuth, setAuth));
            } catch (error) {
              if (!fallbackKey) throw error;
              latchSpillover(`subscription token unavailable (${error.message})`);
              return fetch(OPENAI_API_ENDPOINT, {
                ...init,
                headers: spilloverHeaders(headers, fallbackKey),
              });
            }

            headers.set("authorization", `Bearer ${accessToken}`);
            if (accountId) headers.set("ChatGPT-Account-Id", accountId);

            const maxPercent = fallbackKey ? subscriptionMaxPercent() : 100;

            // With a ceiling below 100 the first request of a sandbox must not
            // discover the ceiling by consuming a turn past it, so ask the usage
            // endpoint first. A failed probe simply leaves the header path to it.
            if (fallbackKey && maxPercent < 100 && !usageProbed) {
              usageProbed = true;
              try {
                const used = await probeUsedPercent(accessToken, accountId);
                if (used !== null && used >= maxPercent) {
                  latchSpillover(`subscription usage at ${used}% of the ${maxPercent}% ceiling`);
                  return fetch(OPENAI_API_ENDPOINT, {
                    ...init,
                    headers: spilloverHeaders(headers, fallbackKey),
                  });
                }
              } catch (error) {
                console.error(
                  `[codex-auth-plugin] usage probe failed, staying on the subscription: ${error.message}`
                );
              }
            }

            const response = await fetch(modelRequest ? CODEX_API_ENDPOINT : parsed, {
              ...init,
              headers,
            });
            if (!fallbackKey) return response;

            // A stream that has already started cannot be replayed, so a spent
            // window observed on a successful call only redirects the next one.
            if (response.status !== 429) {
              const reason = spentReason(response, { maxPercent });
              if (reason) latchSpillover(reason);
              return response;
            }

            const bodyText = await response.text().catch(() => "");
            const reason = spentReason(response, { maxPercent, bodyText });
            if (!reason || typeof init?.body !== "string") {
              return replayResponse(response, bodyText);
            }
            latchSpillover(reason);
            return fetch(OPENAI_API_ENDPOINT, {
              ...init,
              headers: spilloverHeaders(headers, fallbackKey),
            });
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
