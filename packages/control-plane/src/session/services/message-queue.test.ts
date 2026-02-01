/**
 * Tests for MessageQueue service.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createMessageQueue } from "./message-queue";
import type { MessageQueue } from "./types";
import type { MessageRepository, ParticipantRepository } from "../repository/types";
import { createMessageRepository, createParticipantRepository } from "../repository";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";

describe("MessageQueue", () => {
  let queue: MessageQueue;
  let messageRepo: MessageRepository;
  let participantRepo: ParticipantRepository;
  let mockSendToSandbox: Mock;
  let mockSpawnIfNeeded: Mock;
  let mockGetSession: Mock;
  let sql: FakeSqlStorage;

  beforeEach(() => {
    sql = new FakeSqlStorage();

    // Create messages table
    sql.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        attachments TEXT,
        callback_context TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      )
    `);

    // Create participants table
    sql.exec(`
      CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        github_user_id TEXT,
        github_login TEXT,
        github_email TEXT,
        github_name TEXT,
        role TEXT NOT NULL,
        github_access_token_encrypted TEXT,
        github_refresh_token_encrypted TEXT,
        github_token_expires_at INTEGER,
        ws_auth_token TEXT,
        ws_token_created_at INTEGER,
        joined_at INTEGER NOT NULL
      )
    `);

    // Add test participant
    sql.exec(
      `INSERT INTO participants (
        id, user_id, github_login, role, joined_at
      ) VALUES (?, ?, ?, ?, ?)`,
      "participant-1",
      "user-1",
      "testuser",
      "member",
      Date.now()
    );

    messageRepo = createMessageRepository(sql);
    participantRepo = createParticipantRepository(sql);
    mockSendToSandbox = vi.fn().mockResolvedValue(undefined);
    mockSpawnIfNeeded = vi.fn().mockResolvedValue(undefined);
    mockGetSession = vi.fn().mockReturnValue({ model: "claude-haiku-4-5" });

    queue = createMessageQueue({
      messageRepo,
      participantRepo,
      getSession: mockGetSession,
      sendToSandbox: mockSendToSandbox,
      spawnIfNeeded: mockSpawnIfNeeded,
    });
  });

  describe("enqueue", () => {
    it("should create message with pending status", async () => {
      const messageId = await queue.enqueue({
        content: "test command",
        authorId: "participant-1",
        source: "web",
      });

      const message = messageRepo.getById(messageId);
      expect(message).toBeDefined();
      expect(message?.status).toBe("pending");
      expect(message?.content).toBe("test command");
      expect(message?.author_id).toBe("participant-1");
    });

    it("should return generated message ID", async () => {
      const messageId = await queue.enqueue({
        content: "test",
        authorId: "participant-1",
        source: "web",
      });

      expect(messageId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    });

    it("should handle messages from different sources", async () => {
      const webId = await queue.enqueue({
        content: "web message",
        authorId: "participant-1",
        source: "web",
      });

      const apiId = await queue.enqueue({
        content: "api message",
        authorId: "participant-1",
        source: "api",
      });

      const webMessage = messageRepo.getById(webId);
      const apiMessage = messageRepo.getById(apiId);

      expect(webMessage?.source).toBe("web");
      expect(apiMessage?.source).toBe("api");
    });
  });

  describe("processQueue", () => {
    it("should do nothing if queue is empty", async () => {
      await queue.processQueue();

      expect(mockSendToSandbox).not.toHaveBeenCalled();
      expect(mockSpawnIfNeeded).not.toHaveBeenCalled();
    });

    it("should do nothing if a message is already processing", async () => {
      // Add a pending message
      await queue.enqueue({
        content: "pending",
        authorId: "participant-1",
        source: "web",
      });

      // Add a processing message
      const processingId = await queue.enqueue({
        content: "processing",
        authorId: "participant-1",
        source: "web",
      });
      messageRepo.updateStatus(processingId, "processing", {
        startedAt: Date.now(),
      });

      await queue.processQueue();

      expect(mockSendToSandbox).not.toHaveBeenCalled();
    });

    it("should process next pending message in FIFO order", async () => {
      const id1 = await queue.enqueue({
        content: "first",
        authorId: "participant-1",
        source: "web",
      });

      await new Promise((resolve) => setTimeout(resolve, 10)); // Ensure different timestamps

      const id2 = await queue.enqueue({
        content: "second",
        authorId: "participant-1",
        source: "web",
      });

      await queue.processQueue();

      // Should process the first message
      const message1 = messageRepo.getById(id1);
      expect(message1?.status).toBe("processing");

      const message2 = messageRepo.getById(id2);
      expect(message2?.status).toBe("pending");
    });

    it("should send command to sandbox", async () => {
      await queue.enqueue({
        content: "test command",
        authorId: "participant-1",
        source: "web",
      });

      await queue.processQueue();

      expect(mockSendToSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "prompt",
          messageId: expect.any(String),
          content: "test command",
          model: "claude-haiku-4-5",
          author: expect.objectContaining({
            userId: "user-1",
            githubName: null,
          }),
        })
      );
    });

    it("should spawn sandbox if needed", async () => {
      await queue.enqueue({
        content: "test",
        authorId: "participant-1",
        source: "web",
      });

      await queue.processQueue();

      expect(mockSpawnIfNeeded).toHaveBeenCalled();
    });

    it("should update message status to processing", async () => {
      const messageId = await queue.enqueue({
        content: "test",
        authorId: "participant-1",
        source: "web",
      });

      await queue.processQueue();

      const message = messageRepo.getById(messageId);
      expect(message?.status).toBe("processing");
      expect(message?.started_at).toBeGreaterThan(0);
    });

    it("should handle missing author gracefully", async () => {
      await queue.enqueue({
        content: "test",
        authorId: "nonexistent",
        source: "web",
      });

      await queue.processQueue();

      // Should still send command but with minimal author info
      expect(mockSendToSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "prompt",
          author: expect.objectContaining({
            userId: "unknown",
          }),
        })
      );
    });
  });

  describe("error handling", () => {
    it("should handle sandbox send errors gracefully", async () => {
      mockSendToSandbox.mockRejectedValueOnce(new Error("Send failed"));

      await queue.enqueue({
        content: "test",
        authorId: "participant-1",
        source: "web",
      });

      await expect(queue.processQueue()).resolves.not.toThrow();
    });

    it("should handle spawn errors gracefully", async () => {
      mockSpawnIfNeeded.mockRejectedValueOnce(new Error("Spawn failed"));

      await queue.enqueue({
        content: "test",
        authorId: "participant-1",
        source: "web",
      });

      await expect(queue.processQueue()).resolves.not.toThrow();
    });
  });
});
