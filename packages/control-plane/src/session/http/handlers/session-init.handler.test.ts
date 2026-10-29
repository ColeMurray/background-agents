import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import { SessionInitHandler } from "./session-init.handler";
import type { ParticipantRepository } from "../../participant-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { SessionCoreRepository } from "../../session-core-repository";

function createHandler() {
  const repository = {
    getSession: vi.fn(() => null),
    upsertSession: vi.fn(),
    replaceSessionRepositories: vi.fn(),
    transaction: vi.fn((callback: () => void) => callback()),
    createParticipant: vi.fn(),
  };
  const sandboxRepository = {
    createSandbox: vi.fn(),
  } as unknown as SandboxRepository;
  const generateId = vi.fn();
  const now = vi.fn(() => 1234);
  const scheduleWarmSandbox = vi.fn();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const sessionInitHandler = new SessionInitHandler(
    repository as unknown as SessionCoreRepository,
    sandboxRepository,
    repository as unknown as ParticipantRepository,
    "session-do-id",
    scheduleWarmSandbox,
    generateId,
    now
  );

  // Bind the request-scoped log so call sites exercise the threading without
  // repeating it at every invocation.
  const handler = {
    init: (request: Request) => sessionInitHandler.init(request, log),
  };

  return {
    handler,
    repository,
    sandboxRepository,
    generateId,
    now,
    scheduleWarmSandbox,
    log,
  };
}

describe("Codex durable initialization", () => {
  const init = (overrides: Record<string, unknown>) =>
    new Request("http://internal/internal/init", {
      method: "POST",
      body: JSON.stringify({
        sessionName: "codex",
        repoOwner: null,
        repoName: null,
        userId: "owner",
        harness: "codex",
        model: "openai/gpt-5.6-sol",
        ...overrides,
      }),
    });
  it("stores native max unchanged rather than applying OpenCode effort rules", async () => {
    const { handler, repository } = createHandler();
    const response = await handler.init(init({ reasoningEffort: "max" }));
    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: "codex",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "max",
      })
    );
  });
  it.each([
    { model: "bogus" },
    { model: "openai/gpt-5.4" },
    { model: undefined },
    { reasoningEffort: "ultra" },
    { reasoningEffort: "none" },
  ])("rejects an unsupported native choice before transaction or warm spawn", async (overrides) => {
    const { handler, repository, scheduleWarmSandbox } = createHandler();
    expect((await handler.init(init(overrides))).status).toBe(400);
    expect(repository.transaction).not.toHaveBeenCalled();
    expect(scheduleWarmSandbox).not.toHaveBeenCalled();
  });
});
