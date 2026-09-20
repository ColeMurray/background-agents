import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Jobs } from "../jobs";
import { createLogger } from "../logger";
import { AUTOMATION_CONTEXT, LINEAR_CONTEXT, SLACK_CONTEXT } from "../../test/callback-fixtures";
import {
  CallbackNotificationService,
  SLACK_ACTIVITY_REFRESH_INTERVAL_MS,
} from "./callback-notification-service";
import type { MessageRepository } from "./message-repository";

function harness(source = "slack", context: unknown = SLACK_CONTEXT) {
  const send = vi.fn<Jobs["send"]>().mockResolvedValue(undefined);
  const messageRepository = {
    getMessageCallbackContext: vi
      .fn<MessageRepository["getMessageCallbackContext"]>()
      .mockReturnValue({ source, callback_context: JSON.stringify(context) }),
    getProcessingMessageWithStartedAt: vi
      .fn<MessageRepository["getProcessingMessageWithStartedAt"]>()
      .mockReturnValue({ id: "message-1", started_at: 1 }),
  };
  const service = new CallbackNotificationService({
    messageRepository,
    jobs: { send },
    log: createLogger("test", {}, "error"),
    getSessionId: () => "session-1",
    sleep: async () => {},
  });
  return { service, send, messageRepository };
}
const tool = (callId = "call-1") => ({
  type: "tool_call",
  tool: "bash",
  args: {},
  callId,
  status: "running",
});

describe("callback job production", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["slack", SLACK_CONTEXT, "slack.completed"],
    ["linear", LINEAR_CONTEXT, "linear.completed"],
    ["automation", AUTOMATION_CONTEXT, "automation.completed"],
    ["web", AUTOMATION_CONTEXT, "automation.completed"],
  ])(
    "publishes %s completion without holding bot clients or secrets",
    async (source, context, type) => {
      const h = harness(String(source), context);
      await h.service.notifyComplete("message-1", false, "failed");
      expect(h.send).toHaveBeenCalledWith({
        kind: "session.callback",
        payload: {
          version: 1,
          type,
          payload: {
            sessionId: "session-1",
            messageId: "message-1",
            success: false,
            error: "failed",
            timestamp: Date.now(),
            context,
          },
        },
      });
    }
  );

  it("waits for acceptance before completing publication", async () => {
    const h = harness();
    let accept!: () => void;
    h.send.mockReturnValue(
      new Promise<void>((resolve) => {
        accept = resolve;
      })
    );
    const settled = vi.fn();
    const publication = h.service.notifyComplete("message-1", true).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    accept();
    await publication;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("retries a rejected terminal publication with the same event time", async () => {
    const h = harness();
    h.send.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 1000);
      throw Error("unavailable");
    });
    await h.service.notifyComplete("message-1", true);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[0]).toEqual(h.send.mock.calls[1]);
  });

  it("contains exhausted publication failure", async () => {
    const h = harness();
    h.send.mockRejectedValue(Error("unavailable"));
    await expect(h.service.notifyComplete("message-1", true)).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it.each([null, "not json", JSON.stringify({ source: "automation", runId: 4 })])(
    "does not queue malformed context %s",
    async (callback_context) => {
      const h = harness();
      h.messageRepository.getMessageCallbackContext.mockReturnValue({
        source: "slack",
        callback_context,
      });
      await h.service.notifyComplete("message-1", true);
      await h.service.notifyToolCall("message-1", tool());
      expect(h.send).not.toHaveBeenCalled();
    }
  );

  it("queues only Linear starts and preserves transition policy", async () => {
    const context = {
      ...LINEAR_CONTEXT,
      transitionIssueOnStart: true,
      organizationId: "org",
      appUserId: "app",
    };
    const h = harness("linear", context);
    await h.service.notifyStarted("message-1");
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "linear.started",
          payload: expect.objectContaining({ context }),
        }),
      })
    );
    const slack = harness();
    await slack.service.notifyStarted("message-1");
    expect(slack.send).not.toHaveBeenCalled();
  });

  it("deduplicates accepted call IDs even beyond the throttle interval", async () => {
    const h = harness();
    await h.service.notifyToolCall("message-1", tool());
    vi.setSystemTime(Date.now() + 4000);
    await h.service.notifyToolCall("message-1", tool());
    expect(h.send).toHaveBeenCalledOnce();
  });

  it("throttles distinct call IDs within three seconds", async () => {
    const h = harness();
    await h.service.notifyToolCall("message-1", tool());
    vi.setSystemTime(Date.now() + 1000);
    await h.service.notifyToolCall("message-1", tool("call-2"));
    expect(h.send).toHaveBeenCalledOnce();
  });

  it("does not deduplicate a failed publication and never retries cosmetic sends inline", async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(Error("down"));
    await h.service.notifyToolCall("message-1", tool());
    expect(h.send).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 4000);
    await h.service.notifyToolCall("message-1", tool());
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("invalid Linear args do not spend the throttle window", async () => {
    const h = harness("linear", LINEAR_CONTEXT);
    await h.service.notifyToolCall("message-1", { ...tool(), args: undefined });
    await h.service.notifyToolCall("message-1", tool());
    expect(h.send).toHaveBeenCalledOnce();
  });

  it("does not publish automation tool progress", async () => {
    const h = harness("automation", AUTOMATION_CONTEXT);
    await h.service.notifyToolCall("message-1", tool());
    expect(h.send).not.toHaveBeenCalled();
  });

  it("bounds dedup memory with FIFO eviction", async () => {
    const h = harness();
    for (let i = 0; i <= 500; i++) {
      vi.setSystemTime(Date.now() + 4000);
      await h.service.notifyToolCall("message-1", tool(String(i)));
    }
    vi.setSystemTime(Date.now() + 4000);
    await h.service.notifyToolCall("message-1", tool("0"));
    expect(h.send).toHaveBeenCalledTimes(502);
  });

  it("refreshes only the current Slack turn and holds the interval after acceptance", async () => {
    const h = harness();
    await h.service.refreshSlackActivity("other", Date.now());
    expect(h.send).not.toHaveBeenCalled();
    await h.service.refreshSlackActivity("message-1", Date.now());
    await h.service.refreshSlackActivity("message-1", Date.now() + 30_000);
    expect(h.send).toHaveBeenCalledOnce();
    await h.service.refreshSlackActivity(
      "message-1",
      Date.now() + SLACK_ACTIVITY_REFRESH_INTERVAL_MS
    );
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("leaves the refresh interval open on failed publication", async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(Error("down"));
    await h.service.refreshSlackActivity("message-1", Date.now());
    await h.service.refreshSlackActivity("message-1", Date.now() + 30_000);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("an accepted Slack tool callback renews the activity interval", async () => {
    const h = harness();
    await h.service.notifyToolCall("message-1", tool());
    await h.service.refreshSlackActivity("message-1", Date.now() + 30_000);
    expect(h.send).toHaveBeenCalledOnce();
  });
});
