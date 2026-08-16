import { describe, expect, it, vi } from "vitest";
import { DurableObjectSessionInitializationStore } from "./durable-object-session-initialization-store";
import type { ParticipantRepository } from "./participant-repository";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { InitializeSessionInput } from "./session-initialization-store";

function initializationInput(): InitializeSessionInput {
  const primaryRepository = {
    position: 0,
    repoOwner: "acme",
    repoName: "app",
    repoId: 123,
    baseBranch: "main",
  };
  return {
    sessionId: "session-1",
    sessionName: "public-session-1",
    title: "Investigate failure",
    repositories: [primaryRepository],
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: "high",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    codeServerEnabled: false,
    vncEnabled: true,
    sandboxSettings: { vncPort: 6080 },
    environmentId: "environment-1",
    owner: {
      userId: "user-1",
      scmLogin: "octocat",
    },
    createdAt: 100,
  };
}

describe("DurableObjectSessionInitializationStore", () => {
  it("maps initialization to the existing repositories in the original order", async () => {
    const calls: string[] = [];
    const upsertSession = vi.fn(() => calls.push("session"));
    const replaceSessionRepositories = vi.fn(() => calls.push("repositories"));
    const createSandbox = vi.fn(() => calls.push("sandbox"));
    const createParticipant = vi.fn(() => calls.push("owner"));
    const generateId = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        calls.push("sandbox-id");
        return "sandbox-1";
      })
      .mockImplementationOnce(() => {
        calls.push("owner-id");
        return "participant-1";
      });
    const store = new DurableObjectSessionInitializationStore(
      {
        sessionCore: {
          upsertSession,
          replaceSessionRepositories,
        } as unknown as SessionCoreRepository,
        sandbox: { createSandbox } as unknown as SandboxRepository,
        participants: { createParticipant } as unknown as ParticipantRepository,
      },
      generateId
    );

    const operation = store.initializeSession(initializationInput());

    expect(operation).toBeInstanceOf(Promise);
    await operation;
    expect(calls).toEqual([
      "session",
      "repositories",
      "sandbox-id",
      "sandbox",
      "owner-id",
      "owner",
    ]);
    expect(upsertSession).toHaveBeenCalledWith({
      id: "session-1",
      sessionName: "public-session-1",
      title: "Investigate failure",
      repoOwner: "acme",
      repoName: "app",
      repoId: 123,
      baseBranch: "main",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      status: "created",
      parentSessionId: null,
      spawnSource: "user",
      spawnDepth: 0,
      codeServerEnabled: false,
      vncEnabled: true,
      sandboxSettings: JSON.stringify({ vncPort: 6080 }),
      environmentId: "environment-1",
      createdAt: 100,
      updatedAt: 100,
    });
    expect(replaceSessionRepositories).toHaveBeenCalledWith([
      {
        position: 0,
        repoOwner: "acme",
        repoName: "app",
        repoId: 123,
        baseBranch: "main",
      },
    ]);
    expect(createSandbox).toHaveBeenCalledWith({
      id: "sandbox-1",
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 0,
    });
    expect(createParticipant).toHaveBeenCalledWith({
      id: "participant-1",
      userId: "user-1",
      scmLogin: "octocat",
      role: "owner",
      joinedAt: 100,
    });
  });

  it("maps repository-free initialization without scalar repository state", async () => {
    const upsertSession = vi.fn();
    const store = new DurableObjectSessionInitializationStore(
      {
        sessionCore: {
          upsertSession,
          replaceSessionRepositories: vi.fn(),
        } as unknown as SessionCoreRepository,
        sandbox: { createSandbox: vi.fn() } as unknown as SandboxRepository,
        participants: { createParticipant: vi.fn() } as unknown as ParticipantRepository,
      },
      vi.fn(() => "id")
    );

    await store.initializeSession({
      ...initializationInput(),
      repositories: [],
    });

    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: null,
        repoName: null,
        repoId: null,
        baseBranch: null,
      })
    );
  });

  it("rejects with earlier writes retained and later stages untouched", async () => {
    const upsertSession = vi.fn();
    const replaceSessionRepositories = vi.fn(() => {
      throw new Error("repository write failed");
    });
    const createSandbox = vi.fn();
    const createParticipant = vi.fn();
    const generateId = vi.fn(() => "unused-id");
    const store = new DurableObjectSessionInitializationStore(
      {
        sessionCore: {
          upsertSession,
          replaceSessionRepositories,
        } as unknown as SessionCoreRepository,
        sandbox: { createSandbox } as unknown as SandboxRepository,
        participants: { createParticipant } as unknown as ParticipantRepository,
      },
      generateId
    );

    await expect(store.initializeSession(initializationInput())).rejects.toThrow(
      "repository write failed"
    );
    expect(upsertSession).toHaveBeenCalledOnce();
    expect(replaceSessionRepositories).toHaveBeenCalledOnce();
    expect(generateId).not.toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(createParticipant).not.toHaveBeenCalled();
  });
});
