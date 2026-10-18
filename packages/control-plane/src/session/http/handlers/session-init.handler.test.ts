import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import { SessionInitHandler } from "./session-init.handler";
import type { ParticipantRepository } from "../../participant-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { SessionCoreRepository } from "../../session-core-repository";
import { createPiFeatureCapabilitySnapshot } from "@open-inspect/shared/pi-feature-capabilities";

const ENABLED_PI_SNAPSHOT = createPiFeatureCapabilitySnapshot({
  workspace: "writable",
  repositoryEditing: "enabled",
  codeMode: "enabled",
});

function createHandler(options: { existing?: boolean; snapshot?: unknown } = {}) {
  const repository = {
    getSession: vi.fn(() => (options.existing ? { harness: "pi" } : null)),
    getPiFeatureCapabilitySnapshot: vi.fn(() => options.snapshot ?? null),
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
  const piRuntime = { initialize: vi.fn(async () => undefined) };
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
    now,
    piRuntime,
    () => ENABLED_PI_SNAPSHOT
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
    piRuntime,
    log,
  };
}

describe("Pi Durable initialization", () => {
  it("initializes the separate durable runtime without creating or warming a sandbox", async () => {
    const { handler, repository, sandboxRepository, scheduleWarmSandbox, piRuntime } =
      createHandler();
    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        body: JSON.stringify({
          sessionName: "pi",
          repoOwner: null,
          repoName: null,
          userId: "owner",
          harness: "pi",
          model: "openai/gpt-5.6-sol",
          reasoningEffort: "high",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "pi", model: "openai/gpt-5.6-sol" })
    );
    expect(sandboxRepository.createSandbox).not.toHaveBeenCalled();
    expect(scheduleWarmSandbox).not.toHaveBeenCalled();
    expect(piRuntime.initialize).toHaveBeenCalledWith("pi", ENABLED_PI_SNAPSHOT);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ piFeatureCapabilitySnapshot: ENABLED_PI_SNAPSHOT })
    );
  });

  it("initializes repository-backed Pi sessions without creating a sandbox", async () => {
    const { handler, repository, sandboxRepository, scheduleWarmSandbox, piRuntime } =
      createHandler();
    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        body: JSON.stringify({
          sessionName: "pi",
          repoOwner: "acme",
          repoName: "app",
          repoId: 1,
          userId: "owner",
          harness: "pi",
          model: "openai/gpt-5.6-sol",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "pi", repoOwner: "acme", repoName: "app" })
    );
    expect(sandboxRepository.createSandbox).not.toHaveBeenCalled();
    expect(scheduleWarmSandbox).not.toHaveBeenCalled();
    expect(piRuntime.initialize).toHaveBeenCalledWith("pi", ENABLED_PI_SNAPSHOT);
  });

  it("retries a lost initialize response with the exact persisted snapshot", async () => {
    const { handler, repository, piRuntime } = createHandler({
      existing: true,
      snapshot: ENABLED_PI_SNAPSHOT,
    });

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        body: JSON.stringify({
          sessionName: "pi",
          repoOwner: null,
          repoName: null,
          userId: "owner",
          harness: "pi",
          model: "openai/gpt-5.6-sol",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(piRuntime.initialize).toHaveBeenCalledWith("pi", ENABLED_PI_SNAPSHOT);
    expect(repository.upsertSession).not.toHaveBeenCalled();
  });

  it("retries in-process when Pi commits but the first initialize response is lost", async () => {
    const { handler, piRuntime } = createHandler();
    piRuntime.initialize.mockRejectedValueOnce(new Error("response lost"));

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        body: JSON.stringify({
          sessionName: "pi",
          repoOwner: null,
          repoName: null,
          userId: "owner",
          harness: "pi",
          model: "openai/gpt-5.6-sol",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(piRuntime.initialize).toHaveBeenCalledTimes(2);
    expect(piRuntime.initialize).toHaveBeenNthCalledWith(1, "pi", ENABLED_PI_SNAPSHOT);
    expect(piRuntime.initialize).toHaveBeenNthCalledWith(2, "pi", ENABLED_PI_SNAPSHOT);
  });

  it("fails closed when Pi initialization does not complete", async () => {
    const { handler, piRuntime } = createHandler();
    piRuntime.initialize.mockRejectedValue(new Error("unavailable"));

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        body: JSON.stringify({
          sessionName: "pi",
          repoOwner: null,
          repoName: null,
          userId: "owner",
          harness: "pi",
          model: "openai/gpt-5.6-sol",
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(piRuntime.initialize).toHaveBeenCalledTimes(2);
  });
});

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
    const { handler, repository, piRuntime } = createHandler();
    const response = await handler.init(init({ reasoningEffort: "max" }));
    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: "codex",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "max",
        piFeatureCapabilitySnapshot: null,
      })
    );
    expect(piRuntime.initialize).not.toHaveBeenCalled();
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
