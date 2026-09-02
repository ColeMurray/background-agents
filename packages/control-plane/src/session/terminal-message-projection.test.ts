import { describe, expect, it, vi } from "vitest";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import { SessionTerminalMessageProjection } from "./terminal-message-projection";
import type {
  PendingTerminalMessageProjection,
  TerminalMessageProjectionStore,
} from "./terminal-message-projection-store";

const input = {
  messageId: "message-1",
  messageCreatedAt: 1_000,
  terminalMessageCompletedAt: 2_000,
};

function createMemoryStore(initial: PendingTerminalMessageProjection | null = null) {
  let entry = initial;
  const store: TerminalMessageProjectionStore = {
    pending: () => entry,
    setPending: (next) => {
      if (
        !entry ||
        next.messageCreatedAt > entry.messageCreatedAt ||
        (next.messageCreatedAt === entry.messageCreatedAt && next.messageId > entry.messageId)
      ) {
        entry = next;
      }
    },
    recordFailedAttempt: (update) => {
      if (
        entry &&
        entry.messageId === update.messageId &&
        entry.messageCreatedAt === update.messageCreatedAt
      ) {
        entry = { ...entry, attempts: update.attempts, nextAttemptAt: update.nextAttemptAt };
      }
    },
    clearThrough: (message) => {
      if (
        entry &&
        (entry.messageCreatedAt < message.messageCreatedAt ||
          (entry.messageCreatedAt === message.messageCreatedAt &&
            entry.messageId <= message.messageId))
      ) {
        entry = null;
      }
    },
  };
  return { store, pending: () => entry };
}

function createProjection(
  recordLatestTerminalMessage: ReturnType<typeof vi.fn>,
  options: { pending?: PendingTerminalMessageProjection | null; now?: number } = {}
) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const memory = createMemoryStore(options.pending ?? null);
  const alarmScheduler = {
    schedule: vi.fn<(at: number) => Promise<void>>().mockResolvedValue(),
    cancel: vi.fn<() => Promise<void>>().mockResolvedValue(),
    current: vi.fn<() => Promise<number | null>>().mockResolvedValue(null),
  };
  const projection = new SessionTerminalMessageProjection({
    sessionIndex: { recordLatestTerminalMessage } as unknown as SessionIndexStore,
    getSessionId: () => "session-1",
    store: memory.store,
    alarmScheduler,
    now: () => options.now ?? 10_000,
    log: log as unknown as Logger,
  });
  return { projection, log, alarmScheduler, pending: memory.pending, store: memory.store };
}

describe("SessionTerminalMessageProjection", () => {
  it("retries one failed projection with the same idempotency input", async () => {
    const recordLatestTerminalMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(true);
    const { projection, log, alarmScheduler, pending } = createProjection(
      recordLatestTerminalMessage
    );

    await projection.recordTerminalMessage(input);

    expect(recordLatestTerminalMessage).toHaveBeenCalledTimes(2);
    expect(recordLatestTerminalMessage).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      ...input,
    });
    expect(recordLatestTerminalMessage.mock.calls[1]).toEqual(
      recordLatestTerminalMessage.mock.calls[0]
    );
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
    expect(alarmScheduler.schedule).not.toHaveBeenCalled();
    expect(pending()).toBeNull();
  });

  it("defers a projection that fails twice and arms the alarm for it", async () => {
    const recordLatestTerminalMessage = vi.fn().mockRejectedValue(new Error("unavailable"));
    const { projection, log, alarmScheduler, pending } = createProjection(
      recordLatestTerminalMessage
    );

    await projection.recordTerminalMessage(input);

    expect(recordLatestTerminalMessage).toHaveBeenCalledTimes(2);
    expect(pending()).toEqual({ ...input, attempts: 0, nextAttemptAt: 15_000 });
    expect(alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenLastCalledWith(
      "session_terminal_message.projection_deferred",
      expect.objectContaining({ message_id: "message-1", next_attempt_at: 15_000 })
    );
  });

  it("keeps turn settlement alive when arming the retry alarm fails", async () => {
    const recordLatestTerminalMessage = vi.fn().mockRejectedValue(new Error("unavailable"));
    const { projection, log, alarmScheduler, pending } = createProjection(
      recordLatestTerminalMessage
    );
    alarmScheduler.schedule.mockRejectedValue(new Error("alarm storage down"));

    await expect(projection.recordTerminalMessage(input)).resolves.toBeUndefined();

    expect(pending()).toEqual({ ...input, attempts: 0, nextAttemptAt: 15_000 });
    expect(log.warn).toHaveBeenCalledWith(
      "session_terminal_message.projection_retry_arm_failed",
      expect.objectContaining({ message_id: "message-1", next_attempt_at: 15_000 })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("clears a deferred projection once a newer message lands inline", async () => {
    const recordLatestTerminalMessage = vi.fn().mockResolvedValue(true);
    const { projection, pending } = createProjection(recordLatestTerminalMessage, {
      pending: { ...input, attempts: 2, nextAttemptAt: 9_000 },
    });

    await projection.recordTerminalMessage({
      messageId: "message-2",
      messageCreatedAt: 3_000,
      terminalMessageCompletedAt: 4_000,
    });

    expect(pending()).toBeNull();
  });

  it("keeps a deferred projection that is newer than the message that landed", async () => {
    const recordLatestTerminalMessage = vi.fn().mockResolvedValue(true);
    const deferred = {
      messageId: "message-2",
      messageCreatedAt: 3_000,
      terminalMessageCompletedAt: 4_000,
      attempts: 0,
      nextAttemptAt: 9_000,
    };
    const { projection, pending } = createProjection(recordLatestTerminalMessage, {
      pending: deferred,
    });

    await projection.recordTerminalMessage(input);

    expect(pending()).toEqual(deferred);
  });

  describe("flushPending", () => {
    it("does nothing without a deferred projection", async () => {
      const recordLatestTerminalMessage = vi.fn();
      const { projection, alarmScheduler } = createProjection(recordLatestTerminalMessage);

      await projection.flushPending();

      expect(recordLatestTerminalMessage).not.toHaveBeenCalled();
      expect(alarmScheduler.schedule).not.toHaveBeenCalled();
    });

    it("re-arms the alarm when another deadline fired first", async () => {
      const recordLatestTerminalMessage = vi.fn();
      const { projection, alarmScheduler } = createProjection(recordLatestTerminalMessage, {
        pending: { ...input, attempts: 0, nextAttemptAt: 12_000 },
      });

      await projection.flushPending();

      expect(recordLatestTerminalMessage).not.toHaveBeenCalled();
      expect(alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(12_000);
    });

    it("projects a due message and clears it", async () => {
      const recordLatestTerminalMessage = vi.fn().mockResolvedValue(true);
      const { projection, log, pending } = createProjection(recordLatestTerminalMessage, {
        pending: { ...input, attempts: 1, nextAttemptAt: 10_000 },
      });

      await projection.flushPending();

      expect(recordLatestTerminalMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "session-1",
        ...input,
      });
      expect(pending()).toBeNull();
      expect(log.info).toHaveBeenCalledWith(
        "session_terminal_message.projection_recovered",
        expect.objectContaining({ message_id: "message-1", attempts: 1 })
      );
    });

    it("backs off after a failed retry", async () => {
      const recordLatestTerminalMessage = vi.fn().mockRejectedValue(new Error("still down"));
      const { projection, alarmScheduler, pending, log } = createProjection(
        recordLatestTerminalMessage,
        { pending: { ...input, attempts: 2, nextAttemptAt: 10_000 } }
      );

      await projection.flushPending();

      expect(pending()).toEqual({ ...input, attempts: 3, nextAttemptAt: 50_000 });
      expect(alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(50_000);
      expect(log.error).not.toHaveBeenCalled();
    });

    it("leaves a newer message that replaced the entry mid-attempt untouched", async () => {
      let rejectAttempt!: (error: Error) => void;
      const recordLatestTerminalMessage = vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectAttempt = reject;
          })
      );
      const { projection, pending, store } = createProjection(recordLatestTerminalMessage, {
        pending: { ...input, attempts: 6, nextAttemptAt: 10_000 },
      });
      const newer = {
        messageId: "message-2",
        messageCreatedAt: 3_000,
        terminalMessageCompletedAt: 4_000,
        attempts: 0,
        nextAttemptAt: 15_000,
      };

      const flush = projection.flushPending();
      await vi.waitFor(() => expect(recordLatestTerminalMessage).toHaveBeenCalledOnce());
      store.setPending(newer);
      rejectAttempt(new Error("still down"));
      await flush;

      expect(pending()).toEqual(newer);
    });

    it("survives a failed alarm arm after a failed retry", async () => {
      const recordLatestTerminalMessage = vi.fn().mockRejectedValue(new Error("still down"));
      const { projection, alarmScheduler, pending } = createProjection(
        recordLatestTerminalMessage,
        { pending: { ...input, attempts: 1, nextAttemptAt: 10_000 } }
      );
      alarmScheduler.schedule.mockRejectedValue(new Error("alarm storage down"));

      await expect(projection.flushPending()).resolves.toBeUndefined();

      expect(pending()).toEqual({ ...input, attempts: 2, nextAttemptAt: 30_000 });
    });

    it("caps the backoff delay", async () => {
      const recordLatestTerminalMessage = vi.fn().mockRejectedValue(new Error("still down"));
      const { projection, pending } = createProjection(recordLatestTerminalMessage, {
        pending: { ...input, attempts: 6, nextAttemptAt: 10_000 },
      });

      await projection.flushPending();

      expect(pending()?.nextAttemptAt).toBe(10_000 + 5 * 60_000);
    });

    it("abandons a projection after the last attempt and records the failure", async () => {
      const recordLatestTerminalMessage = vi.fn().mockRejectedValue(new Error("still down"));
      const { projection, alarmScheduler, pending, log } = createProjection(
        recordLatestTerminalMessage,
        { pending: { ...input, attempts: 7, nextAttemptAt: 10_000 } }
      );

      await projection.flushPending();

      expect(pending()).toBeNull();
      expect(alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledExactlyOnceWith(
        "session_terminal_message.projection_abandoned",
        expect.objectContaining({ message_id: "message-1", attempts: 8 })
      );
    });
  });

  it("re-arms a deferred projection's deadline on rehydration", async () => {
    const { projection, alarmScheduler } = createProjection(vi.fn(), {
      pending: { ...input, attempts: 0, nextAttemptAt: 12_000 },
    });

    await projection.rearm();

    expect(alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(12_000);
  });
});
