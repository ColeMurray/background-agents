/**
 * Shared HTTP client for sandbox tools that call the control plane.
 *
 * Not a tool (no default tool() export) — OpenCode silently skips files
 * without a default tool export, so the underscore prefix is just a hint.
 */

const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787"
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN || ""

let _cachedSessionId = null

function getSessionId() {
  if (_cachedSessionId !== null) return _cachedSessionId
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}")
    _cachedSessionId = config.sessionId || config.session_id || ""
  } catch {
    _cachedSessionId = ""
  }
  return _cachedSessionId
}

/** Make an authenticated request to the control plane, scoped to the current session. */
export async function bridgeFetch(path, options = {}) {
  const sessionId = getSessionId()
  if (!sessionId) {
    throw new Error("Session ID not found in SESSION_CONFIG environment variable")
  }

  const url = `${BRIDGE_URL}/sessions/${sessionId}${path}`
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${BRIDGE_TOKEN}`,
    ...options.headers,
  }

  return fetch(url, { ...options, headers })
}

/** Extract a human-readable error message from a non-OK response. */
export async function extractError(response) {
  const text = await response.text()
  try {
    const json = JSON.parse(text)
    return json.error || json.message || text
  } catch {
    return text
  }
}
