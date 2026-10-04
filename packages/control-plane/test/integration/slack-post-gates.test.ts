import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env } from "cloudflare:test";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import type { SlackPostDenial } from "../../src/authorization/slack-post-gate";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { createDurableObjectSessionPlatform } from "../../src/cloudflare/session-platform";
import { createSessionRuntime } from "../../src/session/components";
import { AutomationStore } from "../../src/db/automation-store";
import { Scheduler } from "../../src/scheduler/scheduler";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedActiveUser } from "./helpers";
import { makeRunRow, seedRun } from "./run-helpers";
import { runInSessionDO } from "./session-do-access";

const refusals: Array<{
  name: string;
  visibility: SessionVisibility;
  boundTeamId: string | null;
  reason: SlackPostDenial;
  missing?: boolean;
  removeBinding?: boolean;
}> = [
  {
    name: "missing session",
    visibility: "workspace",
    boundTeamId: null,
    reason: "missing_session",
    missing: true,
  },
  {
    name: "private session",
    visibility: "private",
    boundTeamId: null,
    reason: "private_session",
  },
  {
    name: "private session in its own team's channel",
    visibility: "private",
    boundTeamId: "team-a",
    reason: "private_session",
  },
  {
    name: "team-visible cross-team session",
    visibility: "team",
    boundTeamId: "team-b",
    reason: "channel_team_mismatch",
  },
  {
    name: "workspace-visible cross-team session",
    visibility: "workspace",
    boundTeamId: "team-b",
    reason: "channel_team_mismatch",
  },
  {
    name: "team-visible session after channel unbinding",
    visibility: "team",
    boundTeamId: "team-a",
    reason: "channel_team_mismatch",
    removeBinding: true,
  },
  {
    name: "workspace-visible session after channel unbinding",
    visibility: "workspace",
    boundTeamId: "team-a",
    reason: "channel_team_mismatch",
    removeBinding: true,
  },
];

async function setScope(sessionId: string, scope: (typeof refusals)[number]): Promise<void> {
  if (scope.missing) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  } else {
    await env.DB.prepare(
      "UPDATE sessions SET owner_team_id = 'team-a', visibility = ? WHERE id = ?"
    )
      .bind(scope.visibility, sessionId)
      .run();
  }
  if (scope.boundTeamId) {
    await env.DB.prepare(
      "INSERT INTO team_channel_bindings (provider, external_id, team_id, kind, created_at) VALUES ('slack', 'C1', ?, 'source', 1)"
    )
      .bind(scope.boundTeamId)
      .run();
  }
}

async function expectSafeClosure(slackFetch: ReturnType<typeof vi.fn>, sessionId: string) {
  expect(slackFetch).toHaveBeenCalledOnce();
  expect(slackFetch.mock.calls[0][0]).toBe("https://internal/callbacks/thread_closed");
  const body = JSON.parse(String(slackFetch.mock.calls[0][1]?.body));
  expect(body).toEqual({
    kind: "slack.thread_closed",
    sessionId,
    timestamp: expect.any(Number),
    context: { channel: "C1", threadTs: "1700000000.000200" },
    signature: expect.any(String),
  });
  expect(await verifyCallbackSignature(body, "outbound-test-secret")).toBe(true);
}

describe("Slack outbound post gates (real D1)", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user-1");
    for (const teamId of ["team-a", "team-b"]) {
      await env.DB.prepare(
        "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
      )
        .bind(teamId, teamId, teamId)
        .run();
    }
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each([
    { path: "complete", logMessage: "callback.complete_delivery" },
    { path: "tool_call", logMessage: "callback.tool_call" },
    { path: "activity", logMessage: "callback.activity_refresh" },
  ])("session callback: $path", ({ path, logMessage }) => {
    it.each(refusals)("sends only a safe closure for $name", async (scope) => {
      const { stub, sessionName } = await initSession();
      await setScope(sessionName, scope);
      const slackFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const linearFetch = vi.fn();

      await runInSessionDO(stub, async (_instance, state) => {
        const author = state.storage.sql
          .exec<{ id: string }>("SELECT id FROM participants LIMIT 1")
          .one();
        state.storage.sql.exec(
          "INSERT INTO messages (id, author_id, content, source, callback_context, status, created_at, started_at) VALUES ('msg-1', ?, 'secret prompt', 'slack', ?, 'processing', 1, 1)",
          author.id,
          JSON.stringify({
            channel: "C1",
            threadTs: "1700000000.000200",
            repoFullName: "secret/repository",
            model: "secret-model",
          })
        );
        // Build the production composition root against the actual D1 and DO SQLite.
        const runtime = createSessionRuntime(createDurableObjectSessionPlatform(state, env.DB), {
          ...createCloudflareEnv(env),
          SLACK_BOT: { fetch: slackFetch },
          LINEAR_BOT: { fetch: linearFetch },
          SERVICE_AUTH_SECRET_SLACK_BOT: "outbound-test-secret",
          SERVICE_AUTH_SECRET_LINEAR_BOT: "linear-test-secret",
          LOG_LEVEL: "info",
        });
        if (scope.removeBinding) {
          await env.DB.prepare(
            "DELETE FROM team_channel_bindings WHERE provider = 'slack' AND external_id = 'C1'"
          ).run();
        }
        const callbacks = runtime.internals.callbackService;
        if (path === "complete") {
          await callbacks.notifyComplete("msg-1", false, "secret error");
        } else if (path === "tool_call") {
          await callbacks.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            args: { command: "secret command" },
            callId: "call-1",
          });
        } else {
          await callbacks.refreshSlackActivity("msg-1", Date.now());
        }
      });

      await expectSafeClosure(slackFetch, sessionName);
      expect(linearFetch).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
        expect.objectContaining({
          msg: logMessage,
          session_id: sessionName,
          outcome: "rejected",
          reject_reason: scope.reason,
        })
      );
    });
  });

  it.each(refusals)("scheduler sends only a safe closure for $name", async (scope) => {
    const { sessionName } = await initSession();
    await setScope(sessionName, scope);
    const store = new AutomationStore(env.DB);
    await store.create({
      id: "auto-1",
      owner_team_id: "team-a",
      name: "Private automation name",
      instructions: "Secret instructions",
      trigger_type: "schedule",
      schedule_cron: "0 9 * * *",
      schedule_tz: "UTC",
      harness: "opencode",
      model: "anthropic/claude-sonnet-4-6",
      reasoning_effort: null,
      enabled: 1,
      next_run_at: null,
      consecutive_failures: 0,
      created_by: "user-1",
      user_id: "user-1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      event_type: null,
      trigger_config: null,
      trigger_auth_data: null,
    });
    const run = makeRunRow("auto-1", { session_id: sessionName, status: "running" });
    await seedRun(run);
    await env.DB.prepare("UPDATE automation_invocations SET trigger_metadata = ? WHERE id = ?")
      .bind(JSON.stringify({ channel: "C1", messageTs: "1700000000.000200" }), run.invocation_id)
      .run();
    const slackFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const linearFetch = vi.fn();
    const scheduler = new Scheduler(
      env.DB,
      {
        ...createCloudflareEnv(env),
        SLACK_BOT: { fetch: slackFetch },
        LINEAR_BOT: { fetch: linearFetch },
        SERVICE_AUTH_SECRET_SLACK_BOT: "outbound-test-secret",
        SERVICE_AUTH_SECRET_LINEAR_BOT: "linear-test-secret",
      },
      { submit() {} }
    );
    if (scope.removeBinding) {
      await env.DB.prepare(
        "DELETE FROM team_channel_bindings WHERE provider = 'slack' AND external_id = 'C1'"
      ).run();
    }

    await scheduler.runComplete({
      automationId: "auto-1",
      runId: run.id,
      sessionId: sessionName,
      messageId: "msg-1",
      success: false,
      error: "secret error",
    });

    expect((await store.getRunById("auto-1", run.id))?.status).toBe("failed");
    await expectSafeClosure(slackFetch, sessionName);
    expect(linearFetch).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({
        event: "scheduler.slack_complete_denied",
        run_id: run.id,
        session_id: sessionName,
        reason: scope.reason,
      })
    );
  });
});
