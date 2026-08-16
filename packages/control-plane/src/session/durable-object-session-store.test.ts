import { describe, expect, it, vi } from "vitest";
import { DurableObjectSessionStore } from "./durable-object-session-store";
import { EventRepository } from "./event-repository";
import { MessageRepository } from "./message-repository";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import type { ParticipantRepository } from "./participant-repository";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

describe("DurableObjectSessionStore", () => {
  it("exposes repository reads through promises", async () => {
    const getSession = vi.fn(() => null);
    const getSandbox = vi.fn(() => null);
    const store = new DurableObjectSessionStore(
      {
        sessionCore: { getSession } as unknown as SessionCoreRepository,
        sandbox: { getSandbox } as unknown as SandboxRepository,
        participants: {} as ParticipantRepository,
        messages: {} as MessageRepository,
      },
      vi.fn()
    );

    const session = store.getSession();
    const sandbox = store.getSandbox();

    expect(session).toBeInstanceOf(Promise);
    expect(sandbox).toBeInstanceOf(Promise);
    await expect(session).resolves.toBeNull();
    await expect(sandbox).resolves.toBeNull();
    expect(getSession).toHaveBeenCalledOnce();
    expect(getSandbox).toHaveBeenCalledOnce();
  });

  it("delegates initialization in the existing write order without adding a transaction", async () => {
    const calls: string[] = [];
    const sessionCore = {
      upsertSession: vi.fn(() => calls.push("session")),
      replaceSessionRepositories: vi.fn(() => calls.push("repositories")),
    } as unknown as SessionCoreRepository;
    const sandbox = {
      createSandbox: vi.fn(() => calls.push("sandbox")),
    } as unknown as SandboxRepository;
    const participants = {
      createParticipant: vi.fn(() => calls.push("owner")),
    } as unknown as ParticipantRepository;
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
    const store = new DurableObjectSessionStore(
      {
        sessionCore,
        sandbox,
        participants,
        messages: {} as MessageRepository,
      },
      generateId
    );

    const operation = store.initializeSession({
      session: {
        id: "session-1",
        sessionName: "public-session-1",
        title: null,
        repoOwner: null,
        repoName: null,
        model: "anthropic/claude-haiku-4-5",
        status: "created",
        createdAt: 100,
        updatedAt: 100,
      },
      repositories: [],
      sandbox: {
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 0,
      },
      owner: {
        userId: "user-1",
        role: "owner",
        joinedAt: 100,
      },
    });

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
    expect(sandbox.createSandbox).toHaveBeenCalledWith({
      id: "sandbox-1",
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 0,
    });
    expect(participants.createParticipant).toHaveBeenCalledWith({
      id: "participant-1",
      userId: "user-1",
      role: "owner",
      joinedAt: 100,
    });
  });

  it("rejects with earlier initialization writes retained and later stages untouched", async () => {
    const upsertSession = vi.fn();
    const replaceSessionRepositories = vi.fn(() => {
      throw new Error("repository write failed");
    });
    const createSandbox = vi.fn();
    const createParticipant = vi.fn();
    const generateId = vi.fn(() => "unused-id");
    const store = new DurableObjectSessionStore(
      {
        sessionCore: {
          upsertSession,
          replaceSessionRepositories,
        } as unknown as SessionCoreRepository,
        sandbox: { createSandbox } as unknown as SandboxRepository,
        participants: { createParticipant } as unknown as ParticipantRepository,
        messages: {} as MessageRepository,
      },
      generateId
    );

    await expect(
      store.initializeSession({
        session: {
          id: "session-1",
          sessionName: "public-session-1",
          title: null,
          repoOwner: null,
          repoName: null,
          model: "anthropic/claude-haiku-4-5",
          status: "created",
          createdAt: 100,
          updatedAt: 100,
        },
        repositories: [],
        sandbox: {
          status: "pending",
          gitSyncStatus: "pending",
          createdAt: 0,
        },
        owner: {
          userId: "user-1",
          role: "owner",
          joinedAt: 100,
        },
      })
    ).rejects.toThrow("repository write failed");
    expect(upsertSession).toHaveBeenCalledOnce();
    expect(replaceSessionRepositories).toHaveBeenCalledOnce();
    expect(generateId).not.toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(createParticipant).not.toHaveBeenCalled();
  });

  it("keeps prompt persistence inside the repository transactionSync boundary", async () => {
    let transactionCalls = 0;
    let inTransaction = false;
    const writes: Array<{ query: string; inTransaction: boolean }> = [];
    const sql: SqlStorage = {
      exec(query: string): SqlResult {
        writes.push({ query, inTransaction });
        return {
          toArray: () => [],
          one: () => null,
          rowsWritten: query.includes("UPDATE attachments") ? 1 : undefined,
        };
      },
    };
    const transactionSync = <T>(closure: () => T): T => {
      transactionCalls += 1;
      inTransaction = true;
      try {
        return closure();
      } finally {
        inTransaction = false;
      }
    };
    const attachments = new SessionAttachmentRepository(sql);
    const events = new EventRepository(sql, transactionSync);
    const messages = new MessageRepository(sql, transactionSync, attachments, events);
    const store = new DurableObjectSessionStore(
      {
        sessionCore: {} as SessionCoreRepository,
        sandbox: {} as SandboxRepository,
        participants: {} as ParticipantRepository,
        messages,
      },
      vi.fn()
    );

    await store.createPrompt({
      message: {
        id: "message-1",
        authorId: "participant-1",
        content: "Inspect the failure",
        source: "web",
        status: "pending",
        createdAt: 100,
      },
      attachmentIds: ["attachment-1"],
      event: {
        id: "event-1",
        type: "user_message",
        data: "{}",
        messageId: "message-1",
        createdAt: 100,
      },
    });

    expect(transactionCalls).toBe(1);
    expect(writes).toHaveLength(3);
    expect(writes.every((write) => write.inTransaction)).toBe(true);
  });
});
