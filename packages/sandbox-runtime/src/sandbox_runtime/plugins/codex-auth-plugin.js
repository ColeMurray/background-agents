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
const OPENAI_API_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const tokenBroker = createProviderTokenBroker({ provider: "openai", providerLabel: "OpenAI" });

/**
 * Optional per-token key used only once the ChatGPT subscription cannot serve a
 * request. Deliberately not named OPENAI_API_KEY: prepareManagedProviderEnv
 * strips that variable from sessions routed to a subscription, because it
 * selects metered billing outright. This one rides along and stays unused
 * until the subscription cannot answer.
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

/** Entity headers that describe a specific body, not the payload's meaning. */
const TRANSPORT_HEADERS = ["content-encoding", "content-length"];

/**
 * Control-plane provider-access error codes that no retry can clear, so the
 * subscription is genuinely unusable for this session. `exchange_busy`,
 * `provider_unavailable` and `upstream_retry_safe` are deliberately absent:
 * they are transient and must not spend the metered fallback key.
 */
const PERMANENT_SUBSCRIPTION_ERROR_CODES = new Set([
  "account_not_found",
  "account_inactive",
  "account_archived",
  "provider_mismatch",
  "credential_not_found",
  "credential_invalid",
  "reconnect_required",
]);

const ALLOWED_MODELS = new Set([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.1-codex",
]);

const PLATFORM_MODEL_ALIASES = new Map([["gpt-5.3-codex-spark", "gpt-5.3-codex"]]);

// Latched for the rest of the sandbox's life once the subscription is spent, so
// a doomed Codex call is not repeated on every later turn.
let spilloverLatched = false;

// One usage probe per sandbox: afterwards every Codex response carries the
// numbers in its headers for free. `usageProbe` holds it while in flight so
// concurrent requests wait for the same answer instead of racing past it, and
// `usageProbeUsed` keeps the answer itself — a waiter that gave up must not
// take the measurement with it and let the next request past the ceiling.
let usageProbed = false;
let usageProbe = null;
let usageProbeUsed = null;

// Set when a failed fallback hands the next turn back to the subscription, so
// that one turn is not immediately sent to the platform again by the ceiling
// it is meant to be proving it can still serve.
let subscriptionRetryPending = false;

// Bumped by every latch and every recovery, so a fallback that settles late
// can tell whether the routing state it was launched against is still the
// current one before undoing it.
let routingGeneration = 0;

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

/** The destination of either fetch shape, without touching the body. */
function requestUrl(requestInput) {
  if (requestInput instanceof Request) return new URL(requestInput.url);
  return requestInput instanceof URL ? requestInput : new URL(String(requestInput));
}

/**
 * Request-level options an init can carry, which a plain `{method, body,
 * headers}` reconstruction would silently drop. `mode` is included but
 * `navigate` is skipped below: a Request may hold it, an init may not.
 */
const REQUEST_LEVEL_OPTIONS = [
  "cache",
  "credentials",
  "integrity",
  "keepalive",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
];

function abortError(signal) {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Buffer a Request body without outliving the caller's cancellation. A
 * streaming body whose producer stalls would otherwise keep this await pending
 * forever: the signal is only handed to `fetch` afterwards, so an abort would
 * reach neither network leg.
 *
 * Read through an explicit reader rather than `request.text()`: that helper
 * locks the body itself, leaving nothing to cancel, so a producer that keeps
 * enqueueing after the abort would still be drained.
 */
async function readBodyText(request, signal) {
  if (!signal) return request.text();
  if (signal.aborted) {
    // Nothing has locked the body yet, so this is the one place where
    // cancelling the stream directly is both valid and necessary: otherwise
    // the producer of an already-abandoned turn is never told to stop.
    request.body.cancel(abortError(signal)).catch(() => {});
    throw abortError(signal);
  }
  const reader = request.body.getReader();
  const onAbort = () => {
    reader.cancel(abortError(signal)).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    // A cancelled reader reports `done` rather than rejecting, so the abort
    // has to be re-raised here instead of returning a truncated body.
    if (signal.aborted) throw abortError(signal);
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The signal the call should honour. Without the source Request's signal a
 * cancelled turn would leave the subscription or platform call running — but
 * `fetch(request, { signal: null })` deliberately detaches from it, so an
 * explicit null must not fall back to the Request's own signal. An absent or
 * `undefined` member is not an override, matching the fetch spec.
 */
function resolveSignal(request, init) {
  if (init && "signal" in init && init.signal !== undefined) return init.signal ?? undefined;
  return request?.signal;
}

/**
 * Fold both fetch shapes — `(url, init)` and a `Request` — into one plain init.
 * opencode's provider client passes an init today, but a `Request` carries its
 * own method, headers and body, and spreading an absent init would send the
 * subscription call and every spillover retry as a bodiless GET. Buffering the
 * body to a string here is also what lets a 429 be retried at all.
 *
 * Only generation requests come through here: their bodies are JSON by the
 * API's own contract, so decoding one to a string is lossless. Every other
 * request is dispatched from its original shape.
 */
async function normalizeRequest(requestInput, init) {
  const request = requestInput instanceof Request ? requestInput : null;
  const url = requestUrl(requestInput);

  // Native fetch(request, init) REPLACES the Request's headers when init
  // supplies any, so merging them would keep a header the caller meant to drop
  // — an authorization override would leave the source credential in place.
  const headers =
    init?.headers === undefined ? new Headers(request?.headers ?? []) : headersFrom(init);

  const signal = resolveSignal(request, init);

  // `new Request(source, { body: null })` inherits the source body, and for a
  // URL-shaped call a null body is the same as none, so null is no override.
  let body = init?.body ?? undefined;
  if (body === undefined && request?.body) body = await readBodyText(request, signal);

  const inherited = {};
  for (const name of REQUEST_LEVEL_OPTIONS) {
    const value = request?.[name];
    if (!value || (name === "mode" && value === "navigate")) continue;
    inherited[name] = value;
  }

  return { url, headers, inherited, method: init?.method ?? request?.method, body, signal };
}

/**
 * Which generation endpoint a request targets, or null when it targets none.
 *
 * Matched as a path suffix rather than a substring: `/v1/responses/resp_123`
 * retrieves an earlier response and `/v1/chat/completionsXYZ` is not this API
 * at all, so neither may be rewritten onto the Codex backend. A suffix still
 * tolerates a proxied base URL that prefixes a path — including one that omits
 * `/v1` before `/chat/completions`, which the previous substring test accepted.
 */
function generationPath(url) {
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  if (path.endsWith("/chat/completions")) return "/v1/chat/completions";
  return path.endsWith("/v1/responses") ? "/v1/responses" : null;
}

function isChatCompletionsRequest(url) {
  return generationPath(url) === "/v1/chat/completions";
}

function isModelRequest(url) {
  return generationPath(url) !== null;
}

/**
 * Platform endpoint that keeps the request contract the caller chose: Chat
 * Completions and Responses payloads are not interchangeable, so a
 * /chat/completions body must not be replayed against /v1/responses. Origin and
 * path are fixed rather than forwarded from the request, so a proxied base URL
 * cannot steer spillover traffic somewhere else.
 */
function fallbackEndpoint(url) {
  return isChatCompletionsRequest(url) ? OPENAI_CHAT_COMPLETIONS_ENDPOINT : OPENAI_API_ENDPOINT;
}

function toPercent(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const percent = Number(value);
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
  const reached = response.headers.get("x-codex-rate-limit-reached-type")?.toLowerCase();
  if (reached === "primary" || reached === "secondary") {
    return `Codex reported the ${reached} limit reached`;
  }
  const used = usedPercentFromHeaders(response.headers);
  if (used !== null && used >= maxPercent) {
    return `subscription usage at ${used}% of the ${maxPercent}% ceiling`;
  }
  if (/\busage limit(?: has been)? reached\b/i.test(bodyText)) {
    return "the ChatGPT subscription reported its usage limit";
  }
  return null;
}

/**
 * Reads the account's window usage from the ChatGPT usage endpoint, which does
 * not consume any of it. Returns the highest window, or null when the payload
 * carries no usage at all.
 *
 * Deliberately takes no caller signal: the result is shared by every request
 * that arrives while it is in flight, so one caller's cancellation must not
 * cancel it for the others. Its own timeout still bounds it.
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

/**
 * The one-time preflight, shared by concurrent requests. Marking it spent
 * before it settles would let a second request skip a pending preflight and
 * consume the subscription past the ceiling the first one is still measuring.
 * The measurement is retained, so a probe whose only waiter walked away still
 * decides the next request instead of being thrown away with that waiter.
 */
function sharedUsageProbe(accessToken, accountId) {
  if (!usageProbe) {
    usageProbe = probeUsedPercent(accessToken, accountId)
      .then((used) => {
        usageProbeUsed = used;
        return used;
      })
      .finally(() => {
        usageProbed = true;
        usageProbe = null;
      });
  }
  return usageProbe;
}

/** Reject as soon as the caller gives up, without disturbing other waiters. */
function whenAborted(signal) {
  if (!signal) return new Promise(() => {});
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortError(signal));
    else signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

function spilloverHeaders(headers, apiKey) {
  const next = new Headers(headers);
  for (const name of CHATGPT_ONLY_HEADERS) next.delete(name);
  // A source Request's content-length describes the subscription body, which a
  // Spark alias rewrite changes; forwarding it makes the transport reject the
  // fallback before it is sent. content-encoding never describes this
  // already-decoded string body.
  for (const name of TRANSPORT_HEADERS) next.delete(name);
  next.set("authorization", `Bearer ${apiKey}`);
  return next;
}

function platformFallbackBody(body) {
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body);
    const platformModel = PLATFORM_MODEL_ALIASES.get(parsed?.model);
    return platformModel ? JSON.stringify({ ...parsed, model: platformModel }) : body;
  } catch {
    return body;
  }
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
  routingGeneration += 1;
  console.error(
    `[codex-auth-plugin] spilling OpenAI traffic over to ${FALLBACK_KEY_ENV}: ${reason}`
  );
}

/**
 * Hand the next turn back to the subscription. Clearing the latch alone is not
 * enough: a fallback chosen by the preflight would be chosen again from the
 * retained measurement. So the measurement is dropped, exactly one turn is
 * allowed past the ceiling to prove the subscription still answers, and the
 * preflight is re-armed — leaving it spent would disable
 * OPENAI_SUBSCRIPTION_MAX_PERCENT for the rest of the sandbox's life.
 */
function recoverSubscription(detail) {
  spilloverLatched = false;
  usageProbeUsed = null;
  usageProbed = false;
  subscriptionRetryPending = true;
  routingGeneration += 1;
  console.error(`[codex-auth-plugin] ${FALLBACK_KEY_ENV} ${detail}`);
}

async function fetchFallback(fallbackUrl, baseInit, headers, apiKey, reason = null) {
  // Concurrent fallbacks settle in any order. A failure may only undo the
  // routing state it was launched against: without this, a slow 503 would
  // erase a newer sibling's successful latch and send the next turn back to a
  // subscription that a live fallback is already standing in for.
  const generation = routingGeneration;
  const stillCurrent = () => routingGeneration === generation;
  let response;
  try {
    response = await fetch(fallbackUrl, {
      ...baseInit,
      body: platformFallbackBody(baseInit.body),
      headers: spilloverHeaders(headers, apiKey),
    });
  } catch (error) {
    // A DNS, TLS or network rejection never reaches the status check below, so
    // without this a latched sandbox would keep dialling a paid path that
    // cannot answer. A caller that cancelled its own turn says nothing about
    // the path's health, so its state is left alone.
    if (!baseInit.signal?.aborted && stillCurrent()) {
      recoverSubscription(
        `request could not be sent (${error.message}); retrying the subscription on the next turn`
      );
    }
    throw error;
  }
  if (response.ok) {
    if (reason) latchSpillover(reason);
    return response;
  }

  // A platform outage or unsupported model must not strand the sandbox on a
  // permanently failing paid path.
  if (stillCurrent()) {
    recoverSubscription(
      `request failed with status ${response.status}; retrying the subscription on the next turn`
    );
  }
  return response;
}

function isPermanentSubscriptionTokenFailure(error) {
  // The control plane answers 409 for both a credential that needs
  // reconnection and transient exchange contention, so the status alone would
  // spend the paid key on contention. Decide on the control plane's own error
  // code, and only for codes that no retry can clear.
  return (
    error?.name === "ProviderTokenBrokerError" &&
    error.kind === "http" &&
    PERMANENT_SUBSCRIPTION_ERROR_CODES.has(error.providerCode)
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
            const parsed = requestUrl(requestInput);
            const currentAuth = await getAuth();

            // A caller that has switched away from OAuth keeps its own
            // authorization, so the request is none of this proxy's business.
            if (currentAuth.type !== "oauth") return fetch(requestInput, init);

            // Anything that is not a generation call keeps its original shape:
            // flattening it would UTF-8-decode an arbitrary body and drop
            // Request-level options, so a retrieval or administrative call
            // would stop being equivalent to fetch(request). Only the
            // placeholder credential opencode signed with is replaced.
            if (!isModelRequest(parsed)) {
              const proxied = new Request(requestInput, init);
              // A token and the account it belongs to must travel together:
              // ensureAccessToken can answer without an account id, so an
              // inherited header would pair a fresh token with a stale one.
              proxied.headers.delete("authorization");
              proxied.headers.delete("chatgpt-account-id");
              const { accessToken, accountId } = await ensureAccessToken(getAuth, setAuth);
              proxied.headers.set("authorization", `Bearer ${accessToken}`);
              if (accountId) proxied.headers.set("ChatGPT-Account-Id", accountId);
              return fetch(proxied);
            }

            const { headers, inherited, method, body, signal } = await normalizeRequest(
              requestInput,
              init
            );
            const { headers: _discardedHeaders, ...restInit } = init ?? {};
            // An object spread routinely carries keys whose value is
            // `undefined`; Request construction ignores those, so overlaying
            // them here would erase the source Request's own values.
            const overrides = Object.fromEntries(
              Object.entries(restInit).filter(([, value]) => value !== undefined)
            );
            const baseInit = { ...inherited, ...overrides, method, body, signal };

            // opencode signs the request with a placeholder API key; this proxy
            // supplies the real credential instead.
            headers.delete("authorization");
            headers.delete("chatgpt-account-id");

            const fallbackKey = process.env[FALLBACK_KEY_ENV] || "";
            const fallbackUrl = fallbackEndpoint(parsed);

            if (fallbackKey && spilloverLatched) {
              return fetchFallback(fallbackUrl, baseInit, headers, fallbackKey);
            }

            let accessToken;
            let accountId;
            try {
              ({ accessToken, accountId } = await ensureAccessToken(getAuth, setAuth));
            } catch (error) {
              if (!fallbackKey || !isPermanentSubscriptionTokenFailure(error)) throw error;
              return fetchFallback(
                fallbackUrl,
                baseInit,
                headers,
                fallbackKey,
                `subscription token unavailable (${error.message})`
              );
            }

            headers.set("authorization", `Bearer ${accessToken}`);
            if (accountId) headers.set("ChatGPT-Account-Id", accountId);

            const maxPercent = fallbackKey ? subscriptionMaxPercent() : 100;

            // With a ceiling below 100 the first request of a sandbox must not
            // discover the ceiling by consuming a turn past it, so ask the usage
            // endpoint first. A failed probe simply leaves the header path to it.
            // One turn after a failed fallback skips this: its whole purpose is
            // to find out whether the subscription can serve again.
            if (subscriptionRetryPending) {
              subscriptionRetryPending = false;
            } else if (fallbackKey && maxPercent < 100) {
              let used = usageProbeUsed;
              if (!usageProbed) {
                const probe = sharedUsageProbe(accessToken, accountId);
                try {
                  // The probe is shared, so it is raced against this caller's
                  // signal rather than cancelled by it: a turn that gives up
                  // stops waiting without stranding the other waiters, and the
                  // preflight counts as spent only once it settles.
                  used = await Promise.race([probe, whenAborted(signal)]);
                } catch (error) {
                  if (signal?.aborted) throw error;
                  console.error(
                    `[codex-auth-plugin] usage probe failed, staying on the subscription: ${error.message}`
                  );
                  used = usageProbeUsed;
                }
              }
              if (used !== null && used >= maxPercent) {
                return fetchFallback(
                  fallbackUrl,
                  baseInit,
                  headers,
                  fallbackKey,
                  `subscription usage at ${used}% of the ${maxPercent}% ceiling`
                );
              }
            }

            const response = await fetch(CODEX_API_ENDPOINT, {
              ...baseInit,
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
            if (!reason || typeof body !== "string") {
              return replayResponse(response, bodyText);
            }
            return fetchFallback(fallbackUrl, baseInit, headers, fallbackKey, reason);
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
