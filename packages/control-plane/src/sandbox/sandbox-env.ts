import type { McpServerConfig } from "@open-inspect/shared";

/**
 * Shared assembly for the sandbox environment contract.
 *
 * The runtime decodes the `SESSION_CONFIG` env var into a single canonical
 * shape (see the Python `SessionConfig` in
 * `packages/sandbox-runtime/src/sandbox_runtime/types.py`). Every provider used
 * to hand-roll that object independently, which let fields silently diverge —
 * the Daytona provider dropped `mcp_servers` entirely because its local copy
 * never added the key. This module is the single source of truth for the shape
 * so providers serialize it instead of reassembling ad-hoc objects.
 *
 * The runtime reads `session_id`, `branch`, `provider`, `model`, and
 * `mcp_servers` from this payload; `repo_owner` / `repo_name` are included to
 * mirror the full contract.
 */

/** Canonical `SESSION_CONFIG` payload handed to the sandbox runtime. */
export interface SessionConfigPayload {
  session_id: string;
  repo_owner: string | null;
  repo_name: string | null;
  provider: string;
  model: string;
  /** Omitted from the serialized payload when undefined. */
  mcp_servers?: McpServerConfig[];
  /** Omitted from the serialized payload when undefined. */
  branch?: string | null;
}

/** Provider-agnostic inputs needed to assemble a {@link SessionConfigPayload}. */
export interface SessionConfigInput {
  sessionId: string;
  repoOwner: string | null;
  repoName: string | null;
  provider: string;
  model: string;
  mcpServers?: McpServerConfig[];
  branch?: string | null;
}

/**
 * Build the canonical `SESSION_CONFIG` payload from provider inputs.
 *
 * `mcp_servers` is always set (left undefined when absent) so `JSON.stringify`
 * omits it — matching how the runtime treats an absent key and an empty list
 * identically. `branch` is only omitted when undefined; explicit null is
 * preserved for repository-less sessions.
 */
export function buildSessionConfig(input: SessionConfigInput): SessionConfigPayload {
  const payload: SessionConfigPayload = {
    session_id: input.sessionId,
    repo_owner: input.repoOwner,
    repo_name: input.repoName,
    provider: input.provider,
    model: input.model,
    mcp_servers: input.mcpServers,
  };
  if (input.branch !== undefined) {
    payload.branch = input.branch;
  }
  return payload;
}
