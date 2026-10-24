import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../../sandbox/lifecycle/test-helpers";
import type { MessageRepository } from "../../message-repository";
import type { SandboxStateReader } from "../../sandbox-ports";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SessionStatusService } from "../../session-status-service";
import type { SessionTitleService } from "../../title-service";
import { SessionLifecycleHandler } from "./session-lifecycle.handler";

function createHandler(
  harness: "opencode" | "pi" = "opencode",
  hasSandbox = false,
  status: "active" | "archived" = "active",
  inProcessHarness: "opencode" | "pi" = "pi"
) {
  const beginTransition = vi.fn<SessionStatusService["beginTransition"]>();
  const confirmIndexStatus = vi.fn<SessionStatusService["confirmIndexStatus"]>();
  const preserveForArchive = vi.fn(async () => undefined);
  const cancelSandbox = vi.fn(async () => undefined);
  const preservePiArchive = vi.fn(async () => undefined);
  const restoreFromArchive = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const settleFromMessageState = vi.fn(async () => "completed" as const);
  const handler = new SessionLifecycleHandler(
    { getSession: () => createMockSession({ harness, status }) } as SessionCoreRepository,
    { getSandbox: () => (hasSandbox ? ({} as never) : null) } as SandboxStateReader,
    { getPendingOrProcessingCount: () => 0 } as MessageRepository,
    {
      beginTransition,
      confirmIndexStatus,
      settleFromMessageState,
    } as unknown as SessionStatusService,
    {} as SessionTitleService,
    { cancelSandbox, preserveForArchive },
    "session-do-id",
    vi.fn(),
    {
      harness: inProcessHarness,
      preserveForArchive: preservePiArchive,
      restoreFromArchive,
      destroy,
    }
  );
  return {
    handler,
    beginTransition,
    confirmIndexStatus,
    preserveForArchive,
    cancelSandbox,
    preservePiArchive,
    restoreFromArchive,
    destroy,
    settleFromMessageState,
  };
}

describe("SessionLifecycleHandler.archive", () => {
  it("archives successfully without participant authorization", async () => {
    const { handler, beginTransition, preserveForArchive } = createHandler();
    beginTransition.mockResolvedValue(true);

    const response = await handler.archive();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "archived", outcome: "archived" });
    expect(beginTransition).toHaveBeenCalledWith("archived");
    expect(preserveForArchive).toHaveBeenCalledOnce();
    expect(beginTransition.mock.invocationCallOrder[0]).toBeLessThan(
      preserveForArchive.mock.invocationCallOrder[0]
    );
  });

  it("does not preserve when the synchronous local transition fails", async () => {
    const { handler, beginTransition, preserveForArchive, confirmIndexStatus } = createHandler();
    beginTransition.mockImplementation(() => {
      throw new Error("local status write failed");
    });

    await expect(handler.archive()).rejects.toThrow("local status write failed");

    expect(preserveForArchive).not.toHaveBeenCalled();
    expect(confirmIndexStatus).not.toHaveBeenCalled();
  });

  it("archives Pi Durable sessions without sandbox preservation", async () => {
    const { handler, beginTransition, preserveForArchive } = createHandler("pi");
    beginTransition.mockResolvedValue(true);

    expect((await handler.archive()).status).toBe(200);
    expect(preserveForArchive).not.toHaveBeenCalled();
  });

  it("preserves the Pi Durable runtime when a Pi session is archived", async () => {
    const { handler, beginTransition, preservePiArchive } = createHandler("pi");
    beginTransition.mockResolvedValue(true);

    expect((await handler.archive()).status).toBe(200);
    expect(preservePiArchive).toHaveBeenCalledOnce();
  });

  it("does not preserve the Pi Durable runtime for a sandbox session", async () => {
    const { handler, beginTransition, preservePiArchive } = createHandler("opencode");
    beginTransition.mockResolvedValue(true);

    expect((await handler.archive()).status).toBe(200);
    expect(preservePiArchive).not.toHaveBeenCalled();
  });

  it("preserves an execution sandbox attached to a Pi Durable session", async () => {
    const { handler, beginTransition, preserveForArchive } = createHandler("pi", true);
    beginTransition.mockResolvedValue(true);

    expect((await handler.archive()).status).toBe(200);
    expect(preserveForArchive).toHaveBeenCalledOnce();
  });
});

describe("SessionLifecycleHandler.destroy", () => {
  it("destroys a non-Pi in-process runtime through the neutral lifecycle port", async () => {
    const { handler, destroy, cancelSandbox } = createHandler(
      "opencode",
      false,
      "active",
      "opencode"
    );

    await expect(handler.destroy()).resolves.toHaveProperty("status", 200);

    expect(destroy).toHaveBeenCalledWith(expect.any(String));
    expect(cancelSandbox).not.toHaveBeenCalled();
  });
});

describe("SessionLifecycleHandler.unarchive", () => {
  it("restores an in-process runtime before making its session promptable", async () => {
    const { handler, restoreFromArchive, settleFromMessageState } = createHandler(
      "pi",
      false,
      "archived"
    );

    await expect(handler.unarchive()).resolves.toHaveProperty("status", 200);
    expect(restoreFromArchive).toHaveBeenCalledOnce();
    expect(restoreFromArchive.mock.invocationCallOrder[0]).toBeLessThan(
      settleFromMessageState.mock.invocationCallOrder[0]
    );
  });
});

describe("SessionLifecycleHandler.cancel", () => {
  it("cancels a Pi execution sandbox", async () => {
    const { handler, cancelSandbox } = createHandler("pi", true);

    expect((await handler.cancel()).status).toBe(200);
    expect(cancelSandbox).toHaveBeenCalledOnce();
  });

  it("keeps sandbox-free Pi cancellation sandbox-free", async () => {
    const { handler, cancelSandbox } = createHandler("pi", false);

    expect((await handler.cancel()).status).toBe(200);
    expect(cancelSandbox).not.toHaveBeenCalled();
  });
});
