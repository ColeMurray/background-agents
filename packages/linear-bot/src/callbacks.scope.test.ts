import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbacksRouter } from "./callbacks";
import { makePlan } from "./plan";
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
  vi.spyOn(linearClient, "fetchIssueTeamIdWithApiKey").mockResolvedValue(null);
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
  storedMapping?: Record<string, unknown>,
  eventsStatus = 200
) {
  const { kv } = createFakeKV(
    storedMapping ? { "issue:issue-1": JSON.stringify(storedMapping) } : {}
  );
  const fetch = vi.fn(async (input: string | URL | Request) => {
    if (new URL(String(input)).pathname.endsWith("/events")) {
      if (eventsStatus !== 200) return new Response(null, { status: eventsStatus });
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

function expectWithheld(fetch: Awaited<ReturnType<typeof postCompletion>>["fetch"]) {
  const logs = JSON.stringify([
    vi.mocked(console.log).mock.calls,
    vi.mocked(console.warn).mock.calls,
    vi.mocked(console.error).mock.calls,
  ]);
  expect(logs).not.toContain(CONTENT);
  const delivered = JSON.stringify([
    vi.mocked(linearClient.emitAgentActivity).mock.calls,
    vi.mocked(linearClient.postIssueComment).mock.calls,
  ]);
  expect(delivered).not.toContain(CONTENT);
  expect(delivered).toContain("its results cannot be shared on this issue");
  return fetch;
}

function withheldReasons(): string[] {
  return vi
    .mocked(console.warn)
    .mock.calls.map(([line]) => JSON.parse(String(line)))
    .filter((entry) => entry.outcome === "withheld")
    .map((entry) => entry.skip_reason);
}

describe("completion channel scope", () => {
  it("reads the signed team only after verifying the issue still belongs to it", async () => {
    vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
    vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue(issue);

    const { env, fetch, kv } = await postCompletion(
      { ...agentContext, linearTeamId: "external-team-1" },
      { ...mapping, linearTeamId: "other-team" }
    );

    expectScopedReads(fetch);
    expect(kv.get).not.toHaveBeenCalled();
    expect(linearClient.getLinearClient).toHaveBeenCalledOnce();
    expect(linearClient.getLinearClient).toHaveBeenCalledWith(env, "org-1", "app-user-1");
    expect(linearClient.fetchIssueDetails).toHaveBeenCalledWith(client, "issue-1");
    expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(client, "agent-session-1", {
      type: "response",
      body: expect.stringContaining(CONTENT),
    });
    expect(linearClient.postIssueComment).not.toHaveBeenCalled();
  });

  it("withholds content when the issue moved to another Linear team after launch", async () => {
    vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
    vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue({
      ...issue,
      team: { ...issue.team, id: "external-team-2" },
    });

    const { fetch } = await postCompletion({ ...agentContext, linearTeamId: "external-team-1" });

    expect(expectWithheld(fetch)).not.toHaveBeenCalled();
    expect(withheldReasons()).toEqual(["issue_team_changed"]);
    expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(client, "agent-session-1", {
      type: "error",
      body: expect.any(String),
    });
    expect(linearClient.updateAgentSession).toHaveBeenCalledWith(client, "agent-session-1", {
      plan: makePlan("failed"),
    });
  });

  it.each([403, 404, 503])(
    "withholds content instead of reporting success when the scoped read returns %s",
    async (status) => {
      vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
      vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue(issue);

      const { fetch } = await postCompletion(
        { ...agentContext, linearTeamId: "external-team-1" },
        undefined,
        status
      );

      expectWithheld(fetch);
      expect(withheldReasons()).toEqual(["session_read_failed"]);
      expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(client, "agent-session-1", {
        type: "error",
        body: expect.any(String),
      });
      expect(linearClient.updateAgentSession).toHaveBeenCalledWith(client, "agent-session-1", {
        plan: makePlan("failed"),
      });
    }
  );

  it("recovers a legacy context's launch team from its matching issue-session mapping", async () => {
    vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
    vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue(issue);

    const { fetch, kv } = await postCompletion(agentContext, {
      ...mapping,
      linearTeamId: "external-team-1",
      teamId: "internal-owner-team",
    });

    expectScopedReads(fetch);
    expect(kv.get).toHaveBeenCalledWith("issue:issue-1", "json");
  });

  it.each([{}, { sessionId: "different-session" }, { issueId: "different-issue" }])(
    "scopes a legacy context without a matching launch team to the verified current team: %j",
    async (mismatch) => {
      vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
      vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue(issue);

      const { fetch } = await postCompletion(agentContext, {
        ...mapping,
        ...mismatch,
        ...(Object.keys(mismatch).length > 0 ? { linearTeamId: "wrong-team" } : {}),
      });

      expectScopedReads(fetch);
    }
  );

  it("verifies the current team with the fallback API key when no app client exists", async () => {
    vi.mocked(linearClient.fetchIssueTeamIdWithApiKey).mockResolvedValue("external-team-1");

    const { fetch } = await postCompletion({ linearTeamId: "external-team-1" });

    expectScopedReads(fetch);
    expect(linearClient.getLinearClient).not.toHaveBeenCalled();
    expect(linearClient.fetchIssueTeamIdWithApiKey).toHaveBeenCalledWith("fallback-key", "issue-1");
    expect(linearClient.postIssueComment).toHaveBeenCalledWith(
      "fallback-key",
      "issue-1",
      expect.stringContaining(CONTENT)
    );
  });

  it("posts a content-free fallback notice when the API key cannot verify the issue", async () => {
    const { fetch } = await postCompletion({}, { ...mapping, teamId: "internal-owner-team" });

    expect(expectWithheld(fetch)).not.toHaveBeenCalled();
    expect(withheldReasons()).toEqual(["issue_team_unverified"]);
    expect(linearClient.postIssueComment).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { ...issue, team: { ...issue.team, id: " " } },
    { ...issue, id: "different-issue" },
  ])("withholds content when the verified issue has no usable team: %j", async (details) => {
    vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
    vi.mocked(linearClient.fetchIssueDetails).mockResolvedValue(details);

    const { fetch } = await postCompletion({ ...agentContext, linearTeamId: "external-team-1" });

    expect(expectWithheld(fetch)).not.toHaveBeenCalled();
    expect(withheldReasons()).toEqual(["issue_team_unverified"]);
  });

  it("withholds content when verified issue lookup throws", async () => {
    vi.mocked(linearClient.getLinearClient).mockResolvedValue(client);
    vi.mocked(linearClient.fetchIssueDetails).mockRejectedValue(new Error("Linear unavailable"));

    const { fetch } = await postCompletion(agentContext, mapping);

    expect(expectWithheld(fetch)).not.toHaveBeenCalled();
  });
});
