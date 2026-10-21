import { describe, expect, it, vi } from "vitest";
import { MemoryAccessError, MemoryNotFoundError } from "../../../memory/errors";
import type { SessionMemoryService } from "../../../memory/session-memory-service";
import { PiMemoryHandler } from "./pi-memory.handler";

const sessionId = "session-1";

function service(overrides: Partial<SessionMemoryService> = {}) {
  return {
    read: vi.fn(async () => ({
      id: "mem_1",
      status: "active" as const,
      memoryType: "fact" as const,
      scope: { type: "personal" as const },
      title: "Deploy window",
      description: "Deploys happen on Tuesdays",
      content: "Tuesdays only",
      revisionId: "mrev_1",
      revisionNumber: 1,
      authorKind: "user" as const,
      authorUserId: "user_1",
      authorSessionId: null,
    })),
    write: vi.fn(async () => ({
      id: "mem_1",
      status: "active" as const,
      revisionId: "mrev_1",
    })),
    search: vi.fn(async () => ({ results: [], hasMore: false })),
    authorizeWrite: vi.fn(async () => ({ allowed: true as const })),
    ...overrides,
  } as unknown as SessionMemoryService;
}

function handler(memory: SessionMemoryService, options: { active?: boolean } = {}) {
  return new PiMemoryHandler({
    getSessionId: () => sessionId,
    service: () => memory,
    activeOperation: () => options.active ?? true,
  });
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://session/internal/pi-memory/read", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("pi memory handler", () => {
  it("reads through the service with the session's own identity", async () => {
    const memory = service();
    const response = await handler(memory).read(request({ memoryId: "mem_1" }));

    expect(response.status).toBe(200);
    expect(memory.read).toHaveBeenCalledWith(sessionId, "mem_1");
  });

  it("writes through the service with the session's own identity", async () => {
    const memory = service();
    const response = await handler(memory).write(
      request({
        memoryType: "fact",
        title: "Deploy window",
        description: "Deploys happen on Tuesdays",
        content: "Tuesdays only",
        scopeType: "repository",
      })
    );

    expect(response.status).toBe(201);
    expect(memory.write).toHaveBeenCalledWith(sessionId, {
      memoryType: "fact",
      title: "Deploy window",
      description: "Deploys happen on Tuesdays",
      content: "Tuesdays only",
      scopeType: "repository",
    });
  });

  it("answers the write pre-flight with the service's own decision", async () => {
    const memory = service({
      authorizeWrite: vi.fn(async () => ({
        allowed: false as const,
        reason: "Memory scope is outside this session",
      })),
    });
    const response = await handler(memory).authorizeWrite(
      request({
        memoryType: "fact",
        title: "Deploy window",
        description: "Deploys happen on Tuesdays",
        content: "Tuesdays only",
        scopeType: "repository",
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      allowed: false,
      reason: "Memory scope is outside this session",
    });
  });

  it("refuses every operation outside a live turn of this session", async () => {
    const memory = service();
    const response = await handler(memory, { active: false }).read(request({ memoryId: "mem_1" }));

    expect(response.status).toBe(409);
    expect(memory.read).not.toHaveBeenCalled();
  });

  it("conceals an inaccessible record as a missing one", async () => {
    const memory = service({
      read: vi.fn(async () => {
        throw new MemoryNotFoundError();
      }),
    });
    const response = await handler(memory).read(request({ memoryId: "mem_1" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Memory not found" });
  });

  it("answers a forbidden scope with the session's own refusal", async () => {
    const memory = service({
      write: vi.fn(async () => {
        throw new MemoryAccessError("Memory scope is outside this session");
      }),
    });
    const response = await handler(memory).write(
      request({
        memoryType: "fact",
        title: "Deploy window",
        description: "Deploys happen on Tuesdays",
        content: "Tuesdays only",
        scopeType: "repository",
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Memory scope is outside this session" });
  });

  it("rejects a malformed argument before the service is called", async () => {
    const memory = service();
    const response = await handler(memory).write(request({ title: "no scope" }));

    expect(response.status).toBe(400);
    expect(memory.write).not.toHaveBeenCalled();
  });

  it("records the caller's request id as the operation's provenance", async () => {
    const requestIds: string[] = [];
    const memory = service();
    const gated = new PiMemoryHandler({
      getSessionId: () => sessionId,
      service: (requestId) => {
        requestIds.push(requestId);
        return memory;
      },
      activeOperation: () => true,
    });
    await gated.read(request({ memoryId: "mem_1" }, { "x-request-id": "turn-1" }));

    expect(requestIds).toEqual(["turn-1"]);
  });
});
