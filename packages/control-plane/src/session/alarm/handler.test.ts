import { describe, expect, it, vi } from "vitest";
import type { SandboxAlarmResult } from "../../sandbox/lifecycle/ports";
import type { MessageRow } from "../types";
import { createAlarmHandler, type AlarmHandlerDeps } from "./handler";

function makeMessage(id: string): MessageRow {
  return {
    id,
    author_id: "user-test",
    content: "Run tests",
    source: "web",
    model: null,
    reasoning_effort: null,
    attachments: null,
    callback_context: null,
    client_request_id: null,
    request_fingerprint: null,
    autofix_feedback_key: null,
    autofix_pr_key: null,
    origin_context: null,
    status: "pending",
    error_message: null,
    stop_confirmation_deadline: null,
    reported_cost_usd: 0,
    created_at: 1,
    started_at: null,
    completed_at: null,
  };
}

function makeLogger(): AlarmHandlerDeps["log"] {
  const logger: AlarmHandlerDeps["log"] = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function makeDeps(overrides: Partial<AlarmHandlerDeps> = {}): AlarmHandlerDeps {
  const defaults: AlarmHandlerDeps = {
    repository: {
      getProcessingMessageWithStartedAt: vi.fn(() => null),
      getNextPendingMessage: vi.fn(() => null),
    },
    messageQueue: {
      failStuckProcessingMessage: vi.fn(async () => {}),
      failPendingMessage: vi.fn(async () => {}),
    },
    executionStop: {
      recoverStopConfirmationTimeout: vi.fn(async () => {}),
      resumeAfterSandboxTermination: vi.fn(async () => {}),
    },
    lifecycleManager: { handleAlarm: vi.fn(async () => "no_action" as const) },
    terminalMessageProjection: { flushPending: vi.fn(async () => {}) },
    alarmScheduler: {
      schedule: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      current: vi.fn(async () => null),
    },
    getExecutionTimeoutMs: () => 30_000,
    now: () => Date.now(),
    log: makeLogger(),
  };
  return { ...defaults, ...overrides };
}

describe("createAlarmHandler", () => {
  it.each([
    { kind: "boot_budget_exceeded", reason: "Boot budget exceeded" },
    { kind: "connect_timeout_unrecoverable", reason: "Connect timeout" },
  ] satisfies Extract<SandboxAlarmResult, { kind: string }>[])(
    "fails the original pending boot prompt without re-driving work after $kind",
    async (lifecycleResult) => {
      let pendingPrompt = makeMessage("msg-original");
      const messageQueue = {
        failStuckProcessingMessage: vi.fn(async () => {}),
        failPendingMessage: vi.fn(async () => {}),
      };
      const executionStop = {
        recoverStopConfirmationTimeout: vi.fn(async () => {}),
        resumeAfterSandboxTermination: vi.fn(async () => {}),
      };
      const deps = makeDeps({
        repository: {
          getProcessingMessageWithStartedAt: vi.fn(() => null),
          getNextPendingMessage: vi.fn(() => pendingPrompt),
        },
        messageQueue,
        executionStop,
        lifecycleManager: {
          handleAlarm: vi.fn(async () => {
            pendingPrompt = makeMessage("msg-new-head");
            return lifecycleResult;
          }),
        },
      });

      await createAlarmHandler(deps).handle();

      expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledOnce();
      expect(executionStop.resumeAfterSandboxTermination).not.toHaveBeenCalled();
      expect(messageQueue.failPendingMessage).toHaveBeenCalledExactlyOnceWith(
        "msg-original",
        lifecycleResult.reason
      );
    }
  );

  it("re-drives work after a terminated sandbox without failing the pending prompt", async () => {
    const messageQueue = {
      failStuckProcessingMessage: vi.fn(async () => {}),
      failPendingMessage: vi.fn(async () => {}),
    };
    const executionStop = {
      recoverStopConfirmationTimeout: vi.fn(async () => {}),
      resumeAfterSandboxTermination: vi.fn(async () => {}),
    };
    const deps = makeDeps({
      repository: {
        getProcessingMessageWithStartedAt: vi.fn(() => null),
        getNextPendingMessage: vi.fn(() => makeMessage("msg-retry")),
      },
      messageQueue,
      executionStop,
      lifecycleManager: { handleAlarm: vi.fn(async () => "sandbox_terminated" as const) },
    });

    await createAlarmHandler(deps).handle();

    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledOnce();
    expect(executionStop.resumeAfterSandboxTermination).toHaveBeenCalledOnce();
    expect(messageQueue.failPendingMessage).not.toHaveBeenCalled();
  });

  it("still runs lifecycle recovery when terminal projection flush fails, then rethrows", async () => {
    const projectionError = new Error("projection write failed");
    const executionStop = {
      recoverStopConfirmationTimeout: vi.fn(async () => {}),
      resumeAfterSandboxTermination: vi.fn(async () => {}),
    };
    const deps = makeDeps({
      terminalMessageProjection: {
        flushPending: vi.fn(async () => {
          throw projectionError;
        }),
      },
      executionStop,
      lifecycleManager: { handleAlarm: vi.fn(async () => "sandbox_terminated" as const) },
    });

    await expect(createAlarmHandler(deps).handle()).rejects.toThrow(projectionError);
    expect(executionStop.recoverStopConfirmationTimeout).toHaveBeenCalledOnce();
    expect(executionStop.resumeAfterSandboxTermination).toHaveBeenCalledOnce();
  });
});
