import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { CreateSessionResponse } from "@open-inspect/shared/types/session-api";
import { handleAgentSessionEvent } from "./webhook-handler";
import type { AgentSessionWebhook } from "./types";
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

/** Run a delegation and capture session requests, mapping writes, and Linear activities. */
async function delegate(options: {
  config: {
    harness?: HarnessId;
    model?: string | null;
    allowUserPreferenceOverride?: boolean;
    allowLabelModelOverride?: boolean;
  } | null;
  labels?: Array<{ id: string; name: string }>;
  envDefaultModel?: string;
  userModel?: string;
  existingSession?: boolean;
}) {
  const { kv, store, putCalls } = createFakeKV({
    "oauth:client-credentials:org-1": validToken(),
    "config:project-repos": JSON.stringify({ "project-1": { owner: "acme", name: "backend" } }),
    ...(options.userModel
      ? {
          "user_prefs:human-user-1": JSON.stringify({
            userId: "human-user-1",
            model: options.userModel,
            updatedAt: Date.now(),
          }),
        }
      : {}),
    ...(options.existingSession
      ? {
          "issue:issue-1": JSON.stringify({
            sessionId: "session-xyz",
            issueId: "issue-1",
            issueIdentifier: "ENG-42",
            linearTeamId: "team-1",
            repoOwner: "acme",
            repoName: "backend",
            model: "openai/gpt-6-sol",
            createdAt: Date.now(),
          }),
        }
      : {}),
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
    if (path === "/sessions") {
      return Response.json({
        sessionId: "session-xyz",
        status: "created",
      } satisfies CreateSessionResponse);
    }
    if (path === "/sessions/session-xyz/prompt") return Response.json({ ok: true });
    if (path === "/sessions/session-xyz/events") return Response.json({ events: [] });
    throw new Error(`Unexpected control-plane fetch to ${path}`);
  });

  const webhook = makeWebhook(options.labels);
  if (options.existingSession) {
    webhook.action = "prompted";
    webhook.agentActivity = {
      userId: "human-user-1",
      content: { body: "Please continue." },
    };
  }
  await handleAgentSessionEvent(webhook, env, "trace-harness");

  const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
  const createCall = fetchMock.mock.calls[paths.indexOf("/sessions")];
  const promptCall = fetchMock.mock.calls[paths.indexOf("/sessions/session-xyz/prompt")];
  const activityContents = vi
    .mocked(fetch)
    .mock.calls.filter(([input]) => String(input) === "https://api.linear.app/graphql")
    .flatMap(([, init]) => {
      const request = JSON.parse(String(init?.body)) as {
        variables?: { input?: { content?: { type: string; body: string } } };
      };
      return request.variables?.input?.content ?? [];
    });
  const activities = activityContents.map(({ body }) => body).join("\n");
  if (createCall) expect(paths).toContain("/sessions/session-xyz/prompt");
  expect(activities).not.toContain("Failed to create a coding session");
  return {
    createBody: createCall
      ? (JSON.parse(String((createCall[1] as RequestInit).body)) as Record<string, unknown>)
      : null,
    promptBody: promptCall
      ? (JSON.parse(String((promptCall[1] as RequestInit).body)) as Record<string, unknown>)
      : null,
    activities,
    activityContents,
    paths,
    issueSession: store.get("issue:issue-1") ?? null,
    issueSessionWrites: putCalls.filter(({ key }) => key === "issue:issue-1").length,
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
    expect(activities).toContain("with **anthropic/claude-haiku-4-5** (OpenCode).");
  });

  it("creates Claude Agent sessions when Claude Agent is configured", async () => {
    const { createBody, activities } = await delegate({
      config: { harness: "claude", model: "anthropic/claude-sonnet-4-6" },
    });

    expect(createBody).toMatchObject({ harness: "claude", model: "anthropic/claude-sonnet-4-6" });
    expect(activities).toContain("agent: Claude Agent, model: anthropic/claude-sonnet-4-6");
    expect(activities).toContain("with **anthropic/claude-sonnet-4-6** (Claude Agent).");
    expect(activities).not.toContain("Claude Code");
  });

  it("checks compatibility after canonicalizing a stale deployment model", async () => {
    const { createBody } = await delegate({
      config: { harness: "claude" },
      envDefaultModel: "openai/gpt-5",
    });

    expect(createBody).toMatchObject({ harness: "claude", model: "anthropic/claude-sonnet-4-6" });
  });

  it.each([
    {
      source: "a model label",
      config: { harness: "claude" },
      labels: [{ id: "label-1", name: "model:gpt-6-sol" }],
    },
    {
      source: "the deployment default",
      config: { harness: "claude" },
      envDefaultModel: "gpt-6-sol",
    },
    { source: "integration settings", config: { harness: "claude", model: "gpt-6-sol" } },
    { source: "a user preference", config: { harness: "claude" }, userModel: "gpt-6-sol" },
    {
      source: "retired integration settings",
      config: { harness: "claude", model: "openai/gpt-5.3-codex-spark" },
    },
  ] satisfies Array<Parameters<typeof delegate>[0] & { source: string }>)(
    "refuses an incompatible canonical model from $source",
    async (options) => {
      const { createBody, activities, activityContents, paths, issueSession, issueSessionWrites } =
        await delegate(options);

      expect(createBody).toBeNull();
      expect(paths.some((path) => path.startsWith("/sessions"))).toBe(false);
      expect(issueSession).toBeNull();
      expect(issueSessionWrites).toBe(0);
      expect(activities).not.toContain("Creating coding session");
      expect(activityContents.filter(({ type }) => type === "error")).toEqual([
        {
          type: "error",
          body: expect.stringContaining(
            'Model "openai/gpt-6-sol" cannot run on the Claude Agent harness.'
          ),
        },
      ]);
      expect(activities).toContain("compatible model label, user preference, or default model");
      expect(activities).toContain("change the Linear integration harness");
    }
  );

  it.each([
    { userModel: "claude-sonnet-4-6" },
    { userModel: "gpt-6-sol", labels: [{ id: "label-1", name: "model:claude-sonnet-4-6" }] },
  ])("launches compatible overrides on Claude Agent (%j)", async (options) => {
    const { createBody, activities, issueSessionWrites } = await delegate({
      config: { harness: "claude", model: "openai/gpt-6-sol" },
      ...options,
    });

    expect(createBody).toMatchObject({ harness: "claude", model: "anthropic/claude-sonnet-4-6" });
    expect(activities).toContain("agent: Claude Agent, model: anthropic/claude-sonnet-4-6");
    expect(issueSessionWrites).toBe(1);
  });

  it("ignores disabled user and label overrides before checking compatibility", async () => {
    const { createBody } = await delegate({
      config: {
        harness: "claude",
        model: "anthropic/claude-sonnet-4-6",
        allowUserPreferenceOverride: false,
        allowLabelModelOverride: false,
      },
      userModel: "gpt-6-sol",
      labels: [{ id: "label-1", name: "model:gpt-6-sol" }],
    });

    expect(createBody).toMatchObject({ harness: "claude", model: "anthropic/claude-sonnet-4-6" });
  });

  it.each([undefined, "opencode"] as const)(
    "runs non-Anthropic overrides on harness %s",
    async (harness) => {
      const { createBody, activities } = await delegate({
        config: { harness },
        labels: [{ id: "label-1", name: "model:gpt-6-sol" }],
      });

      expect(createBody).toMatchObject({ harness: "opencode", model: "openai/gpt-6-sol" });
      expect(activities).toContain("with **openai/gpt-6-sol** (OpenCode).");
    }
  );

  it("keeps existing-session follow-ups unchanged despite incompatible current settings", async () => {
    const { createBody, promptBody, activities, paths, issueSessionWrites } = await delegate({
      config: { harness: "claude", model: "openai/gpt-6-sol" },
      existingSession: true,
      userModel: "gpt-6-sol",
      labels: [{ id: "label-1", name: "model:gpt-6-sol" }],
    });

    expect(createBody).toBeNull();
    expect(paths).toContain("/sessions/session-xyz/prompt");
    expect(promptBody).toMatchObject({ callbackContext: { model: "openai/gpt-6-sol" } });
    expect(activities).toContain("Follow-up sent to existing session.");
    expect(activities).not.toContain("cannot run on");
    expect(issueSessionWrites).toBe(0);
  });
});
