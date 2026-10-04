import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../../sandbox/lifecycle/test-helpers";
import type { MessageRepository } from "../../message-repository";
import type { SandboxStateReader } from "../../sandbox-ports";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SessionStatusService } from "../../session-status-service";
import type { SessionTitleService } from "../../title-service";
import { SessionLifecycleHandler } from "./session-lifecycle.handler";

function createHandler() {
  const beginTransition = vi.fn<SessionStatusService["beginTransition"]>();
  const confirmIndexStatus = vi.fn<SessionStatusService["confirmIndexStatus"]>();
  const preserveForArchive = vi.fn(async () => undefined);
  const handler = new SessionLifecycleHandler(
    { getSession: () => createMockSession() } as SessionCoreRepository,
    {} as SandboxStateReader,
    { getPendingOrProcessingCount: () => 0 } as MessageRepository,
    { beginTransition, confirmIndexStatus } as unknown as SessionStatusService,
    {} as SessionTitleService,
    { cancelSandbox: vi.fn(), preserveForArchive },
    "session-do-id",
    vi.fn()
  );
  return { handler, beginTransition, confirmIndexStatus, preserveForArchive };
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
});
