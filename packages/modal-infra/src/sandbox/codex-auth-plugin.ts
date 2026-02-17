/**
 * Codex Auth Proxy Plugin for Open-Inspect.
 *
 * Overrides the built-in CodexAuthPlugin to delegate token refresh to the
 * control plane instead of calling OpenAI directly. This ensures rotating
 * refresh tokens are persisted centrally in D1 rather than being lost when
 * ephemeral sandboxes terminate.
 *
 * Auto-loaded from .opencode/plugins/ — OpenCode discovers project plugins
 * and deduplicates by provider ID (last wins), so this replaces the built-in.
 */
import type { Plugin } from "@opencode-ai/plugin"

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"
const REFRESH_BUFFER_MS = 5 * 60 * 1000 // 5 minutes before expiry

const ALLOWED_MODELS = new Set([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
])

// In-memory token cache (reset on sandbox restart — fresh refresh via bridge)
let cachedAccessToken: string | null = null
let cachedAccountId: string | null = null
let cachedExpiresAt = 0

function getSessionId(): string {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}")
    return config.sessionId || config.session_id || ""
  } catch {
    return ""
  }
}

async function refreshViaControlPlane(): Promise<{
  access_token: string
  expires_in?: number
  account_id?: string
}> {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL
  const authToken = process.env.SANDBOX_AUTH_TOKEN
  const sessionId = getSessionId()

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
    )
  }

  const response = await fetch(
    `${controlPlaneUrl}/sessions/${sessionId}/openai-token-refresh`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    }
  )

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200)
    throw new Error(`Token refresh failed (${response.status}): ${body}`)
  }

  return response.json()
}

interface OpenAIAuthState {
  type: string
  refresh: string
  access: string
  expires: number
  accountId?: string
}

async function ensureAccessToken(
  getAuth: () => Promise<OpenAIAuthState>,
  setAuth: (body: OpenAIAuthState) => Promise<void>
): Promise<{ accessToken: string; accountId: string | null }> {
  const now = Date.now()

  // Return cached token if still fresh
  if (cachedAccessToken && cachedExpiresAt - now > REFRESH_BUFFER_MS) {
    return { accessToken: cachedAccessToken, accountId: cachedAccountId }
  }

  // Refresh via control plane
  const result = await refreshViaControlPlane()

  cachedAccessToken = result.access_token
  cachedAccountId = result.account_id || null
  cachedExpiresAt = now + (result.expires_in ?? 3600) * 1000

  // Update OpenCode's auth state for consistency
  try {
    const currentAuth = await getAuth()
    await setAuth({
      type: "oauth",
      refresh: currentAuth?.refresh || "managed-by-control-plane",
      access: result.access_token,
      expires: cachedExpiresAt,
      ...(cachedAccountId && { accountId: cachedAccountId }),
    })
  } catch {
    // Non-fatal: the in-memory cache is the source of truth
  }

  return { accessToken: cachedAccessToken, accountId: cachedAccountId }
}

export const CodexAuthProxy: Plugin = async (input) => {
  return {
    auth: {
      provider: "openai",
      methods: [],
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Filter to allowed Codex models
        for (const modelId of Object.keys(provider.models)) {
          if (!ALLOWED_MODELS.has(modelId)) {
            delete provider.models[modelId]
          }
        }

        // Inject gpt-5.3-codex if missing
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
          }
        }

        // Zero out costs (Codex is subscription-based)
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        const setAuth = async (body: OpenAIAuthState) => {
          await input.client.auth.set({ path: { id: "openai" }, body })
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            // Remove dummy API key authorization header
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization"
                )
              } else {
                delete (init.headers as Record<string, string>)["authorization"]
                delete (init.headers as Record<string, string>)["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Ensure we have a valid access token
            const { accessToken, accountId } = await ensureAccessToken(getAuth, setAuth)

            // Build headers
            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(
                  init.headers as Record<string, string>
                )) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }

            // Set real authorization
            headers.set("authorization", `Bearer ${accessToken}`)

            // Set ChatGPT-Account-Id header
            if (accountId) {
              headers.set("ChatGPT-Account-Id", accountId)
            }

            // Rewrite URL to Codex endpoint
            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(
                    typeof requestInput === "string" ? requestInput : requestInput.url
                  )
            const url =
              parsed.pathname.includes("/v1/responses") ||
              parsed.pathname.includes("/chat/completions")
                ? new URL(CODEX_API_ENDPOINT)
                : parsed

            return fetch(url, { ...init, headers })
          },
        }
      },
    },

    "chat.headers": async (chatInput, output) => {
      if (chatInput.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers.session_id = chatInput.sessionID
    },
  }
}
