import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventResponse } from "@open-inspect/shared/types/sandbox-events";
import type { Env } from "../types";
import { processSlackCompletion } from "./delivery";
import type { SlackCompletionJob } from "./job";

const job: SlackCompletionJob = {
  version: 1,
  deliveryId: "11111111-1111-4111-8111-111111111111",
  source: "automation",
  sessionId: "session-1",
  messageId: "message-1",
  success: true,
  channel: "C123",
  threadTs: "111.222",
  reactionMessageTs: "111.222",
  context: { repoFullName: "acme/app", model: "anthropic/claude-haiku-4-5" },
};

// Scheduler prompts omit mcpEligible. A launched personal connector is reported
// unavailable, not silently omitted, and the runtime can still complete the turn.
const warning =
  "Personal MCP example is unavailable (mcp_execution_inactive). " +
  "Connect or reconnect in Settings: https://app.test/settings?tab=mcp-connections. " +
  "Other tools remain available.";

function setup(
  withMcpWarning: boolean,
  response: { textContent?: string; success?: boolean; artifact?: boolean } = {}
) {
  const events: EventResponse[] = [
    ...(withMcpWarning
      ? [
          {
            id: "warning-1",
            type: "warning" as const,
            messageId: job.messageId,
            createdAt: 1,
            data: { scope: "mcp", message: warning },
          },
        ]
      : []),
    {
      id: "token-1",
      type: "token",
      messageId: job.messageId,
      createdAt: 2,
      data: { content: response.textContent ?? "NO_REPLY" },
    },
    {
      id: "completion-1",
      type: "execution_complete",
      messageId: job.messageId,
      createdAt: 3,
      data: { success: response.success ?? true },
    },
  ];
  if (response.artifact) {
    events.push({
      id: "artifact-1",
      type: "artifact",
      messageId: job.messageId,
      createdAt: 2,
      data: { artifactType: "pr", url: "https://github.com/acme/app/pull/1" },
    });
  }
  const controlPlaneFetch = vi.fn<Env["CONTROL_PLANE"]["fetch"]>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.searchParams.get("purpose")).toBe("slack-post");
    expect(url.searchParams.get("channel")).toBe("slack:C123");
    if (url.pathname === `/sessions/${job.sessionId}/events`) {
      expect(url.searchParams.get("message_id")).toBe(job.messageId);
      return Response.json({ events, hasMore: false });
    }
    if (url.pathname === `/sessions/${job.sessionId}/artifacts`) {
      return Response.json({ artifacts: [] });
    }
    throw new Error(`Unexpected control-plane request: ${url}`);
  });
  const slackFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://slack.com/api/chat.postMessage") {
      return Response.json({ ok: true, channel: job.channel, ts: "333.444" });
    }
    if (url === "https://slack.com/api/reactions.remove") {
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected Slack request: ${url}`);
  });
  const env: Env = {
    SLACK_KV: { get: vi.fn(async () => null) } as unknown as KVNamespace,
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    SLACK_COMPLETION_QUEUE: { send: vi.fn() },
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: job.context.model,
    CLASSIFICATION_MODEL: job.context.model,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    SERVICE_AUTH_SECRET: "internal-secret",
    LOG_LEVEL: "error",
  };
  return { env, controlPlaneFetch, slackFetch };
}

afterEach(() => vi.restoreAllMocks());

describe("MCP warning completion delivery", () => {
  it.each(["NO_REPLY", " no_reply. ", "", "   "])(
    "posts only the operational warning when an automation declines with %j",
    async (textContent) => {
      const { env, controlPlaneFetch, slackFetch } = setup(true, { textContent });

      // Keep delivery, event extraction, block building, and Slack serialization real.
      await expect(processSlackCompletion(job, env)).resolves.toEqual({ kind: "ack" });

      expect(controlPlaneFetch).toHaveBeenCalledTimes(3);
      expect(slackFetch).toHaveBeenCalledTimes(2);
      expect(slackFetch.mock.calls[0]?.[0]).toBe("https://slack.com/api/chat.postMessage");
      const payload = JSON.parse(String(slackFetch.mock.calls[0]?.[1]?.body));
      expect(payload).toMatchObject({ channel: job.channel, thread_ts: job.threadTs });
      expect(payload.blocks).toEqual([
        { type: "section", text: { type: "mrkdwn", text: `:warning: ${warning}` } },
        expect.objectContaining({ type: "context" }),
        expect.objectContaining({
          type: "actions",
          elements: expect.arrayContaining([
            expect.objectContaining({
              action_id: "mcp_connections",
              url: "https://app.test/settings?tab=mcp-connections",
            }),
          ]),
        }),
      ]);
      expect(slackFetch.mock.calls[1]?.[0]).toBe("https://slack.com/api/reactions.remove");
    }
  );

  it("suppresses NO_REPLY without MCP warnings while still clearing the reaction", async () => {
    const { env, controlPlaneFetch, slackFetch } = setup(false);

    await expect(processSlackCompletion(job, env)).resolves.toEqual({ kind: "ack" });

    expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
    expect(slackFetch).toHaveBeenCalledOnce();
    expect(slackFetch.mock.calls[0]?.[0]).toBe("https://slack.com/api/reactions.remove");
    expect(JSON.parse(String(slackFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      channel: job.channel,
      timestamp: job.reactionMessageTs,
      name: "eyes",
    });
  });

  it.each([
    { name: "interactive", jobOverrides: { source: "session" as const }, response: {} },
    { name: "failed job", jobOverrides: { success: false }, response: {} },
    { name: "failed execution", jobOverrides: {}, response: { success: false } },
    { name: "artifact-producing", jobOverrides: {}, response: { artifact: true } },
    {
      name: "substantive automation",
      jobOverrides: {},
      response: { textContent: "NO_REPLY is the sentinel you asked about." },
    },
  ])("preserves $name response text alongside MCP warnings", async ({ jobOverrides, response }) => {
    const { env, controlPlaneFetch, slackFetch } = setup(true, response);

    await expect(processSlackCompletion({ ...job, ...jobOverrides }, env)).resolves.toEqual({
      kind: "ack",
    });

    expect(controlPlaneFetch).toHaveBeenCalledTimes(3);
    expect(slackFetch).toHaveBeenCalledTimes(2);
    expect(slackFetch.mock.calls[0]?.[0]).toBe("https://slack.com/api/chat.postMessage");
    const payload = JSON.parse(String(slackFetch.mock.calls[0]?.[1]?.body));
    expect(payload.blocks[0]).toMatchObject({
      type: "markdown",
      text: response.textContent ?? "NO_REPLY",
    });
    expect(payload.blocks[1]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: `:warning: ${warning}` },
    });
    if (response.artifact) {
      expect(JSON.stringify(payload.blocks)).toContain("https://github.com/acme/app/pull/1");
    }
  });
});
