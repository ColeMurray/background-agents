import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { handleAgentSessionEvent } from "./webhook-handler";
import type { AgentSessionWebhook, Env } from "./types";
import {
  createFakeKV,
  createLinearFetchMock,
  linearClientCredentialsResponse,
  linearIdentityResponse,
  makeLinearBotEnv,
} from "./test-helpers";

const TOKEN_TTL_MS = 60 * 60 * 1000;

function validToken(): string {
  const issuedAt = Date.now();
  return JSON.stringify({
    version: 1,
    access_token: "valid-token",
    token_type: "Bearer",
    scope: "read,write,app:assignable,app:mentionable",
    issued_at: issuedAt,
    expires_at: issuedAt + TOKEN_TTL_MS,
    organization_id: "org-1",
    organization_name: "Acme",
    app_user_id: "app-user-1",
  });
}

function makeWebhook(labels: Array<{ id: string; name: string }> = []): AgentSessionWebhook {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    webhookId: "webhook-created",
    appUserId: "app-user-1",
    agentSession: {
      id: "agent-session-1",
      creatorId: "human-user-1",
      issue: {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Fix the flow",
        description: "Details.",
        url: "https://linear.app/acme/issue/ENG-42/fix",
        priority: 0,
        priorityLabel: "No priority",
        team: { id: "team-1", key: "ENG", name: "Engineering" },
        labels,
        project: { id: "project-1", name: "Backend" },
      },
    },
  };
}

/** Run a new-session delegation and return the create-session body and Linear activity text. */
async function delegate(options: {
  config: { harness?: HarnessId; model?: string | null } | null;
  labels?: Array<{ id: string; name: string }>;
  envDefaultModel?: string;
}): Promise<{ createBody: Record<string, unknown>; activities: string }> {
  const { kv } = createFakeKV({
    "oauth:client-credentials:org-1": validToken(),
    "config:project-repos": JSON.stringify({ "project-1": { owner: "acme", name: "backend" } }),
  });
  const env = makeLinearBotEnv(kv, {
    ...(options.envDefaultModel ? { DEFAULT_MODEL: options.envDefaultModel } : {}),
  });
  const config = options.config && {
    model: null,
    reasoningEffort: null,
    allowUserPreferenceOverride: true,
    allowLabelModelOverride: true,
    emitToolProgressActivities: true,
    issueSessionInstructions: null,
    enabledRepos: null,
    ...options.config,
  };
  const fetchMock = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/channel-bindings/linear/")) return Response.json({ teamId: null });
    if (path.startsWith("/integration-settings/linear/resolved/")) {
      return Response.json({ config });
    }
    if (path === "/sessions") return Response.json({ sessionId: "session-xyz" });
    if (path === "/sessions/session-xyz/prompt") return Response.json({ ok: true });
    throw new Error(`Unexpected control-plane fetch to ${path}`);
  });

  await handleAgentSessionEvent(makeWebhook(options.labels), env as Env, "trace-harness");

  const createCall = fetchMock.mock.calls.find(
    ([input]) => new URL(String(input)).pathname === "/sessions"
  );
  return {
    createBody: JSON.parse(String((createCall?.[1] as RequestInit).body)),
    activities: vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => String(init?.body))
      .join("\n"),
  };
}

describe("handleAgentSessionEvent harness selection", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () => linearClientCredentialsResponse("runtime-token"),
        identity: () => linearIdentityResponse(),
        graphql: () => Response.json({ data: {} }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([null, {}])("creates OpenCode sessions when no harness is configured (%j)", async (c) => {
    const { createBody, activities } = await delegate({ config: c });

    expect(createBody).toMatchObject({ harness: "opencode", model: "anthropic/claude-haiku-4-5" });
    expect(activities).toContain("agent: OpenCode, model: anthropic/claude-haiku-4-5");
  });

  it("creates Claude Agent sessions when Claude Agent is configured", async () => {
    const { createBody, activities } = await delegate({
      config: { harness: "claude", model: "anthropic/claude-sonnet-4-6" },
    });

    expect(createBody).toMatchObject({ harness: "claude", model: "anthropic/claude-sonnet-4-6" });
    expect(activities).toContain("agent: Claude Agent, model: anthropic/claude-sonnet-4-6");
    expect(activities).not.toContain("Claude Code");
  });

  it.each([
    ["a model label", { labels: [{ id: "label-1", name: "model:gpt-6-sol" }] }],
    ["the deployment default", { envDefaultModel: "openai/gpt-6-sol" }],
  ])(
    "runs a non-Anthropic model from %s on OpenCode under Claude Agent",
    async (_source, options) => {
      const { createBody, activities } = await delegate({
        config: { harness: "claude" },
        ...options,
      });

      expect(createBody).toMatchObject({ harness: "opencode", model: "openai/gpt-6-sol" });
      expect(activities).toContain("agent: OpenCode, model: openai/gpt-6-sol");
    }
  );
});
