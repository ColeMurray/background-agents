import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../../sandbox/lifecycle/test-helpers";
import type { MessageRepository } from "../../message-repository";
import type { SandboxStateReader } from "../../sandbox-ports";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SessionStatusService } from "../../session-status-service";
import type { SessionTitleService } from "../../title-service";
import { SessionLifecycleHandler } from "./session-lifecycle.handler";

function createHandler(harness: "opencode" | "pi" = "opencode", hasSandbox = false) {
  const beginTransition = vi.fn<SessionStatusService["beginTransition"]>();
  const confirmIndexStatus = vi.fn<SessionStatusService["confirmIndexStatus"]>();
  const preserveForArchive = vi.fn(async () => undefined);
  const cancelSandbox = vi.fn(async () => undefined);
  const preservePiArchive = vi.fn(async () => undefined);
  const handler = new SessionLifecycleHandler(
    { getSession: () => createMockSession({ harness }) } as SessionCoreRepository,
    { getSandbox: () => (hasSandbox ? ({} as never) : null) } as SandboxStateReader,
    { getPendingOrProcessingCount: () => 0 } as MessageRepository,
    { beginTransition, confirmIndexStatus } as unknown as SessionStatusService,
    {} as SessionTitleService,
    { cancelSandbox, preserveForArchive },
    "session-do-id",
    vi.fn(),
    preservePiArchive
  );
  return {
    handler,
    beginTransition,
    confirmIndexStatus,
    preserveForArchive,
    cancelSandbox,
    preservePiArchive,
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
