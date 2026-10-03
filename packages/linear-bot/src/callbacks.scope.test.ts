import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbacksRouter } from "./callbacks";
import { createFakeKV, makeExecutionContext, makeLinearBotEnv } from "./test-helpers";
import * as linearClient from "./utils/linear-client";
import type { LinearIssueDetails } from "./types";

const NOW = 1_700_000_000_000;
const SECRET = "callback-secret";
const CONTENT = "Private session response";
const client: linearClient.LinearApiClient = {
  accessToken: "verified-token",
  organizationId: "org-1",
  renewAccessToken: async () => "renewed-token",
};
const issue: LinearIssueDetails = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix login",
  url: "https://linear.app/acme/issue/ENG-1",
  priority: 1,
  priorityLabel: "High",
  labels: [],
  comments: [],
  team: { id: "external-team-1", key: "ENG", name: "Engineering" },
};
const mapping = {
  sessionId: "session-1",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  model: "anthropic/claude-haiku-4-5",
  createdAt: NOW,
};
const agentContext = {
  agentSessionId: "agent-session-1",
  organizationId: "org-1",
  appUserId: "app-user-1",
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(linearClient, "getLinearClient").mockResolvedValue(null);
  vi.spyOn(linearClient, "fetchIssueDetails").mockResolvedValue(null);
  vi.spyOn(linearClient, "emitAgentActivity").mockResolvedValue(true);
  vi.spyOn(linearClient, "updateAgentSession").mockResolvedValue(undefined);
  vi.spyOn(linearClient, "postIssueComment").mockResolvedValue({ success: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function postCompletion(
  context: Record<string, unknown> = {},
  storedMapping?: Record<string, unknown>
) {
  const { kv } = createFakeKV(
    storedMapping ? { "issue:issue-1": JSON.stringify(storedMapping) } : {}
  );
  const fetch = vi.fn(async (input: string | URL | Request) => {
    if (new URL(String(input)).pathname.endsWith("/events")) {
      return Response.json({
        events: [
          {
            id: "token-1",
            type: "token",
            data: { content: CONTENT },
            messageId: "message-1",
            createdAt: NOW,
          },
        ],
        hasMore: false,
      });
    }
    return Response.json({ artifacts: [] });
  });
  const env = makeLinearBotEnv(kv, {
    SERVICE_AUTH_SECRET: SECRET,
    LINEAR_API_KEY: "fallback-key",
    CONTROL_PLANE: { fetch },
  });
  const data = {
    sessionId: "session-1",
    messageId: "message-1",
    success: true,
    timestamp: NOW,
    context: {
      source: "linear",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueUrl: issue.url,
      model: mapping.model,
      ...context,
    },
  };
  const payload = { ...data, signature: await computeHmacHex(JSON.stringify(data), SECRET) };
  const ctx = makeExecutionContext();
  const response = await callbacksRouter.fetch(
    new Request("http://localhost/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace-id": "trace-complete" },
      body: JSON.stringify(payload),
    }),
    env,
    ctx
  );
  expect(response.status).toBe(200);
  await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));
  return { env, fetch, kv };
}

function expectScopedReads(fetch: Awaited<ReturnType<typeof postCompletion>>["fetch"]) {
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [input] of fetch.mock.calls) {
    expect(new URL(String(input)).searchParams.get("channel")).toBe("linear:external-team-1");
  }
}

function expectNoCompletionReads(fetch: Awaited<ReturnType<typeof postCompletion>>["fetch"]) {
  expect(fetch).not.toHaveBeenCalled();
  expect(linearClient.emitAgentActivity).not.toHaveBeenCalled();
  expect(linearClient.postIssueComment).not.toHaveBeenCalled();
  const logs = JSON.stringify([
    vi.mocked(console.log).mock.calls,
    vi.mocked(console.warn).mock.calls,
    vi.mocked(console.error).mock.calls,
  ]);
  expect(logs).not.toContain(CONTENT);
}

describe("completion channel scope", () => {
  it("uses signed context without consulting mappings or fetching issue details", async () => {
    const { fetch, kv } = await postCompletion(
      { linearTeamId: "external-team-1" },
      { ...mapping, linearTeamId: "other-team" }
    );

    expectScopedReads(fetch);
    expect(kv.get).not.toHaveBeenCalled();
    expect(linearClient.getLinearClient).not.toHaveBeenCalled();
    expect(linearClient.fetchIssueDetails).not.toHaveBeenCalled();
    expect(linearClient.postIssueComment).toHaveBeenCalledWith(
      "fallback-key",
      "issue-1",
      expect.stringContaining(CONTENT)
    );
  });

  it("recovers a legacy context's external team from its matching issue-session mapping", async () => {
    const { fetch, kv } = await postCompletion(
      {},
      {
        ...mapping,
        linearTeamId: "external-team-1",
        teamId: "internal-owner-team",
      }
    );

    expectScopedReads(fetch);
    expect(kv.get).toHaveBeenCalledWith("issue:issue-1", "json");
    expect(linearClient.getLinearClient).not.toHaveBeenCalled();
    expect(linearClient.fetchIssueDetails).not.toHaveBeenCalled();
  });

  it("recovers the external team through the verified app client and reuses it for delivery", async () => {
    vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
    vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue(issue);

    const { env, fetch } = await postCompletion(agentContext, mapping);

    expectScopedReads(fetch);
    expect(linearClient.getLinearClient).toHaveBeenCalledOnce();
    expect(linearClient.getLinearClient).toHaveBeenCalledWith(env, "org-1", "app-user-1");
    expect(linearClient.fetchIssueDetails).toHaveBeenCalledWith(client, "issue-1");
    expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(client, "agent-session-1", {
      type: "response",
      body: expect.stringContaining(CONTENT),
    });
    expect(linearClient.postIssueComment).not.toHaveBeenCalled();
  });

  it.each([{ sessionId: "different-session" }, { issueId: "different-issue" }])(
    "ignores a mismatched mapping %j and recovers via the verified client",
    async (mismatch) => {
      vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
      vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue(issue);

      const { fetch } = await postCompletion(agentContext, {
        ...mapping,
        ...mismatch,
        linearTeamId: "wrong-team",
      });

      expectScopedReads(fetch);
      expect(linearClient.fetchIssueDetails).toHaveBeenCalledWith(client, "issue-1");
    }
  );

  it.each([{}, { organizationId: "org-1" }, { appUserId: "app-user-1" }])(
    "skips legacy completion with no verifiable Linear client identity: %j",
    async (context) => {
      const { fetch } = await postCompletion(context, {
        ...mapping,
        teamId: "internal-owner-team",
      });

      expectNoCompletionReads(fetch);
      expect(linearClient.getLinearClient).not.toHaveBeenCalled();
      expect(linearClient.fetchIssueDetails).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('"skip_reason":"missing_linear_team_id"')
      );
    }
  );

  it("skips legacy completion when verified credentials are unavailable, even with an API key", async () => {
    const { fetch } = await postCompletion(agentContext, mapping);

    expectNoCompletionReads(fetch);
    expect(linearClient.getLinearClient).toHaveBeenCalled();
    expect(linearClient.fetchIssueDetails).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...issue, team: { ...issue.team, id: " " } },
    { ...issue, id: "different-issue" },
  ])(
    "skips legacy completion when the verified issue cannot supply its external team: %j",
    async (details) => {
      vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
      vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue(details);

      const { fetch } = await postCompletion(agentContext, mapping);

      expectNoCompletionReads(fetch);
    }
  );

  it("does not read completion content when verified issue recovery throws", async () => {
    vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
    vi.mocked(linearClient.fetchIssueDetails).mockRejectedValue(new Error("Linear unavailable"));

    const { fetch } = await postCompletion(agentContext, mapping);

    expectNoCompletionReads(fetch);
  });
});
