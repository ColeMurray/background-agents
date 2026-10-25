import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex, verifyCallbackSignature } from "@open-inspect/shared/auth";
import type { AutomationRunRow } from "../db/automation-store";
import type { Logger } from "../logger";
import { retryDelivery } from "../session/callback-delivery";
import type { AutomationRunCompletion } from "./contracts";
import { AutomationSlackService, type AutomationSlackServiceDeps } from "./slack-service";

const mockStore = { getInvocationById: vi.fn(), getById: vi.fn() };
const mockSessionStoreGet = vi.fn();
const mockTeamChannelBindingGet = vi.fn();
const getGlobal = vi.fn();
const sampleSlackAutomation = { model: "anthropic/claude-sonnet-4-6", reasoning_effort: null };

function sampleRunRow(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
  return {
    id: "run-1",
    automation_id: "auto-1",
    invocation_id: "inv-1",
    session_id: "sess-1",
    status: "running",
    skip_reason: null,
    failure_reason: null,
    scheduled_at: 0,
    started_at: 0,
    completed_at: null,
    execution_deadline_at: null,
    created_at: 0,
    repo_owner: "acme",
    repo_name: "web-app",
    repo_id: 12345,
    base_branch: "main",
    environment_id: null,
    first_prompt_pending: 0,
    ...overrides,
  };
}

function runCompletion(overrides: Partial<AutomationRunCompletion> = {}): AutomationRunCompletion {
  return {
    automationId: "auto-1",
    runId: "run-1",
    sessionId: "sess-1",
    messageId: "msg-1",
    success: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createSlackCompletionHarness(overrides: Partial<AutomationSlackServiceDeps> = {}) {
  const slackFetch = vi.fn().mockResolvedValue(new Response("ok"));
  const warn = vi.fn<Logger["warn"]>();
  const info = vi.fn<Logger["info"]>();
  const log: Logger = { debug: vi.fn(), warn, info, error: vi.fn(), child: () => log };
  const service = new AutomationSlackService({
    bot: { fetch: slackFetch },
    signingSecret: "test-secret",
    automations: mockStore,
    settings: { getGlobal },
    postScope: { getSession: mockSessionStoreGet, getChannelBinding: mockTeamChannelBindingGet },
    sign: computeHmacHex,
    retryDelivery,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clock: Date,
    log,
    ...overrides,
  });
  return { service, slackFetch, warn, info };
}

let run: AutomationRunRow;
describe("AutomationSlackService completion publication", () => {
  beforeEach(() => {
    run = sampleRunRow();
    mockStore.getInvocationById.mockReset().mockResolvedValue({
      trigger_metadata: JSON.stringify({ channel: "C1", messageTs: "1700000000.000200" }),
    });
    mockStore.getById.mockReset().mockResolvedValue(sampleSlackAutomation);
    mockSessionStoreGet
      .mockReset()
      .mockResolvedValue({ ownerTeamId: "team-a", visibility: "workspace" });
    mockTeamChannelBindingGet.mockReset().mockResolvedValue({ teamId: "team-a" });
    getGlobal.mockReset().mockResolvedValue(null);
  });
  it("labels a repo-less run as No repository", async () => {
    const { service, slackFetch } = createSlackCompletionHarness();
    run = sampleRunRow({ repo_owner: null, repo_name: null, repo_id: null, base_branch: null });

    await service.notifyCompletion(run, runCompletion());

    expect(slackFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(slackFetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      channel: "C1",
      reactionMessageTs: "1700000000.000200",
      repoFullName: "No repository",
    });
  });

  it.each(["none", "invocation", "automation", "session", "channel"] as const)(
    "reads invocation coordinates and run-snapshot labels after %s preparation failure",
    async (lookup) => {
      const { service, slackFetch, warn } = createSlackCompletionHarness();
      run = sampleRunRow({ automation_id: "auto-slack", invocation_id: "inv-slack" });
      mockStore.getById.mockResolvedValue({
        ...sampleSlackAutomation,
        repo_name: "changed-repository",
      });
      mockTeamChannelBindingGet.mockResolvedValue({ teamId: "team-a" });
      const read =
        lookup === "none"
          ? null
          : {
              invocation: mockStore.getInvocationById,
              automation: mockStore.getById,
              session: mockSessionStoreGet,
              channel: mockTeamChannelBindingGet,
            }[lookup];
      read?.mockRejectedValueOnce(new Error("D1 unavailable"));

      await expect(
        service.notifyCompletion(run, runCompletion({ automationId: "auto-slack" }))
      ).resolves.toBeUndefined();

      expect(mockStore.getInvocationById).toHaveBeenCalledWith("inv-slack");
      expect(mockStore.getInvocationById).toHaveBeenCalledTimes(read ? 2 : 1);
      expect(mockSessionStoreGet).toHaveBeenCalledWith("sess-1");
      expect(mockTeamChannelBindingGet).toHaveBeenCalledWith("C1");
      expect(slackFetch).toHaveBeenCalledOnce();
      expect(slackFetch.mock.calls[0][0]).toBe("https://internal/callbacks/automation-complete");
      const body = JSON.parse(String(slackFetch.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        channel: "C1",
        reactionMessageTs: "1700000000.000200",
        repoFullName: "acme/web-app",
        sessionId: "sess-1",
        messageId: "msg-1",
        success: true,
      });
      expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
      if (read) {
        expect(read).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          "Slack completion callback failed",
          expect.objectContaining({ event: "scheduler.slack_complete_failed", attempt: 1 })
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    { visibility: "private", binding: null, reason: "private_session" },
    { visibility: "workspace", binding: null, reason: "channel_team_mismatch" },
    {
      visibility: "workspace",
      binding: { teamId: "team-b" },
      reason: "channel_team_mismatch",
    },
  ])("selects only closure after recovering $reason", async ({ visibility, binding }) => {
    const { service, slackFetch } = createSlackCompletionHarness();
    mockSessionStoreGet
      .mockRejectedValueOnce(new Error("D1 unavailable"))
      .mockResolvedValue({ ownerTeamId: "team-a", visibility });
    mockTeamChannelBindingGet.mockResolvedValue(binding);
    slackFetch.mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(
      service.notifyCompletion(run, runCompletion({ success: false, error: "secret error" }))
    ).resolves.toBeUndefined();

    expect(mockStore.getInvocationById).toHaveBeenCalledTimes(2);
    expect(mockSessionStoreGet).toHaveBeenCalledTimes(2);
    expect(slackFetch).toHaveBeenCalledOnce();
    expect(slackFetch.mock.calls[0][0]).toBe("https://internal/callbacks/thread_closed");
    const body = JSON.parse(String(slackFetch.mock.calls[0][1]?.body));
    expect(body).toEqual({
      kind: "slack.thread_closed",
      sessionId: "sess-1",
      timestamp: expect.any(Number),
      context: { channel: "C1", threadTs: "1700000000.000200" },
      signature: expect.any(String),
    });
    expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
  });

  it.each([null, { teamId: "team-b" }])(
    "rechecks preparation and scope after transport failure without a nested loop: %j",
    async (binding) => {
      const { service, slackFetch, warn } = createSlackCompletionHarness();
      mockTeamChannelBindingGet
        .mockResolvedValueOnce({ teamId: "team-a" })
        .mockResolvedValue(binding);
      slackFetch.mockResolvedValue(new Response("unavailable", { status: 503 }));
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        await service.notifyCompletion(
          run,
          runCompletion({ success: false, error: "secret error" })
        );

        expect(mockStore.getInvocationById).toHaveBeenCalledTimes(2);
        expect(mockStore.getById).toHaveBeenCalledTimes(2);
        expect(mockSessionStoreGet).toHaveBeenCalledTimes(2);
        expect(mockTeamChannelBindingGet).toHaveBeenCalledTimes(2);
        expect(slackFetch.mock.calls.map(([url]) => url)).toEqual([
          "https://internal/callbacks/automation-complete",
          "https://internal/callbacks/thread_closed",
        ]);
        const closure = JSON.parse(String(slackFetch.mock.calls[1][1]?.body));
        expect(closure.context).toEqual({ channel: "C1", threadTs: "1700000000.000200" });
        expect(closure).not.toHaveProperty("error");
        expect(closure).not.toHaveProperty("messageId");
        expect(setTimeoutSpy.mock.calls.map(([, ms]) => ms)).toEqual([10_000, 1000, 10_000]);
        expect(
          warn.mock.calls
            .filter(([, fields]) => fields?.event === "scheduler.slack_complete_failed")
            .map(([, fields]) => fields?.attempt)
        ).toEqual([1, 2]);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    }
  );

  it.each([
    { visibility: "private", binding: { teamId: "team-a" }, reason: "private_session" },
    { visibility: "workspace", binding: null, reason: "channel_team_mismatch" },
    {
      visibility: "workspace",
      binding: { teamId: "team-b" },
      reason: "channel_team_mismatch",
    },
  ])(
    "retains closure and denial after $reason even when current scope allows completion",
    async ({ visibility, binding, reason }) => {
      vi.useFakeTimers();
      try {
        const { service, slackFetch, warn, info } = createSlackCompletionHarness();
        mockSessionStoreGet.mockResolvedValue({ ownerTeamId: "team-a", visibility });
        mockTeamChannelBindingGet.mockResolvedValue(binding);
        const firstAttempt = deferred<void>();
        slackFetch
          .mockImplementationOnce(async () => {
            mockSessionStoreGet.mockResolvedValue({
              ownerTeamId: "team-a",
              visibility: "workspace",
            });
            mockTeamChannelBindingGet.mockResolvedValue({ teamId: "team-a" });
            firstAttempt.resolve();
            return new Response("unavailable", { status: 503 });
          })
          .mockResolvedValueOnce(new Response("ok"));
        const completion = service.notifyCompletion(
          run,
          runCompletion({ success: false, error: "secret error" })
        );

        await firstAttempt.promise;
        await vi.advanceTimersByTimeAsync(1000);
        await completion;

        expect(mockSessionStoreGet).toHaveBeenCalledTimes(2);
        expect(mockTeamChannelBindingGet).toHaveBeenCalledTimes(2);
        expect(slackFetch.mock.calls.map(([url]) => url)).toEqual([
          "https://internal/callbacks/thread_closed",
          "https://internal/callbacks/thread_closed",
        ]);
        for (const [, init] of slackFetch.mock.calls) {
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual({
            kind: "slack.thread_closed",
            sessionId: "sess-1",
            timestamp: expect.any(Number),
            context: { channel: "C1", threadTs: "1700000000.000200" },
            signature: expect.any(String),
          });
          expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
        }
        expect(warn).toHaveBeenCalledWith(
          "Slack completion callback failed",
          expect.objectContaining({
            event: "scheduler.slack_complete_failed",
            attempt: 1,
            http_status: 503,
          })
        );
        expect(
          info.mock.calls.filter(
            ([, fields]) => fields?.event === "scheduler.slack_complete_denied"
          )
        ).toEqual([
          ["Slack completion denied by session scope", expect.objectContaining({ reason })],
          ["Slack completion denied by session scope", expect.objectContaining({ reason })],
        ]);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each(["invocation", "automation", "session", "channel"] as const)(
    "contains exhausted %s reads without transport",
    async (lookup) => {
      const { service, slackFetch, warn } = createSlackCompletionHarness();
      const read = {
        invocation: mockStore.getInvocationById,
        automation: mockStore.getById,
        session: mockSessionStoreGet,
        channel: mockTeamChannelBindingGet,
      }[lookup];
      read.mockRejectedValue(new Error("D1 unavailable"));

      await expect(service.notifyCompletion(run, runCompletion())).resolves.toBeUndefined();

      expect(read).toHaveBeenCalledTimes(2);
      expect(mockStore.getInvocationById).toHaveBeenCalledTimes(2);
      expect(slackFetch).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([, fields]) => fields?.attempt)).toEqual([1, 2]);
    }
  );

  it.each(["workspace", "private"] as const)(
    "does not transport a timed-out %s attempt after its uncancelable D1 read finishes",
    async (visibility) => {
      vi.useFakeTimers();
      try {
        const { service, slackFetch, info } = createSlackCompletionHarness();
        const pendingRead = deferred<unknown>();
        const readStarted = deferred<void>();
        mockSessionStoreGet.mockImplementationOnce(() => {
          readStarted.resolve();
          return pendingRead.promise;
        });
        const completion = service.notifyCompletion(run, runCompletion());

        await readStarted.promise;
        await vi.advanceTimersByTimeAsync(10_000);
        pendingRead.resolve({ ownerTeamId: "team-a", visibility });
        await vi.advanceTimersByTimeAsync(1000);
        await completion;

        expect(mockSessionStoreGet).toHaveBeenCalledTimes(2);
        expect(slackFetch).toHaveBeenCalledOnce();
        expect(slackFetch.mock.calls[0][0]).toBe("https://internal/callbacks/automation-complete");
        expect(slackFetch.mock.calls[0][1]?.signal.aborted).toBe(false);
        expect(info).not.toHaveBeenCalledWith(
          "Slack completion denied by session scope",
          expect.anything()
        );
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each([{ bot: undefined }, { signingSecret: undefined }])(
    "skips publication preparation when callback configuration is absent: %j",
    async (overrides) => {
      const { service, slackFetch } = createSlackCompletionHarness(overrides);

      await service.notifyCompletion(run, runCompletion());

      expect(mockStore.getInvocationById).not.toHaveBeenCalled();
      expect(mockStore.getById).not.toHaveBeenCalled();
      expect(mockSessionStoreGet).not.toHaveBeenCalled();
      expect(slackFetch).not.toHaveBeenCalled();
    }
  );
});
