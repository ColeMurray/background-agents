/**
 * Tests for MessageRepository implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";
import { createMessageRepository } from "./message-repository";
import { initSchema } from "../schema";
import type { MessageRepository } from "./types";

describe("MessageRepository", () => {
  let sql: FakeSqlStorage;
  let repo: MessageRepository;

  beforeEach(() => {
    sql = new FakeSqlStorage();
    initSchema(sql as unknown as SqlStorage);
    repo = createMessageRepository(sql as unknown as SqlStorage);
  });

  describe("create", () => {
    it("should create a new message with required fields", () => {
      const message = repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "Hello world",
        source: "web",
        createdAt: Date.now(),
      });

      expect(message.id).toBe("msg-1");
      expect(message.author_id).toBe("author-1");
      expect(message.content).toBe("Hello world");
      expect(message.source).toBe("web");
      expect(message.status).toBe("pending");
    });

    it("should create a message with optional model field", () => {
      const message = repo.create({
        id: "msg-2",
        authorId: "author-1",
        content: "Test",
        source: "slack",
        model: "claude-sonnet-4-5",
        createdAt: Date.now(),
      });

      expect(message.model).toBe("claude-sonnet-4-5");
    });

    it("should create a message with attachments", () => {
      const attachments = JSON.stringify([{ type: "file", name: "test.ts" }]);
      const message = repo.create({
        id: "msg-3",
        authorId: "author-1",
        content: "Check this file",
        source: "web",
        attachments,
        createdAt: Date.now(),
      });

      expect(message.attachments).toBe(attachments);
    });

    it("should create a message with callback context", () => {
      const callbackContext = JSON.stringify({ channel: "C123", threadTs: "1234" });
      const message = repo.create({
        id: "msg-4",
        authorId: "author-1",
        content: "From Slack",
        source: "slack",
        callbackContext,
        createdAt: Date.now(),
      });

      expect(message.callback_context).toBe(callbackContext);
    });
  });

  describe("getById", () => {
    it("should return null when message does not exist", () => {
      const message = repo.getById("nonexistent");
      expect(message).toBeNull();
    });

    it("should return message when it exists", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "Test",
        source: "web",
        createdAt: Date.now(),
      });

      const message = repo.getById("msg-1");
      expect(message).not.toBeNull();
      expect(message?.id).toBe("msg-1");
    });
  });

  describe("getProcessing", () => {
    it("should return null when no message is processing", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "Pending",
        source: "web",
        createdAt: Date.now(),
      });

      const processing = repo.getProcessing();
      expect(processing).toBeNull();
    });

    it("should return the processing message", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "Test",
        source: "web",
        createdAt: Date.now(),
      });

      repo.updateStatus("msg-1", "processing", { startedAt: Date.now() });

      const processing = repo.getProcessing();
      expect(processing).not.toBeNull();
      expect(processing?.id).toBe("msg-1");
      expect(processing?.status).toBe("processing");
    });

    it("should return only one processing message even if multiple exist", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "First",
        source: "web",
        createdAt: Date.now(),
      });
      repo.create({
        id: "msg-2",
        authorId: "author-1",
        content: "Second",
        source: "web",
        createdAt: Date.now(),
      });

      repo.updateStatus("msg-1", "processing");
      repo.updateStatus("msg-2", "processing");

      const processing = repo.getProcessing();
      expect(processing).not.toBeNull();
    });
  });

  describe("getNextPending", () => {
    it("should return null when no pending messages exist", () => {
      const pending = repo.getNextPending();
      expect(pending).toBeNull();
    });

    it("should return the oldest pending message", () => {
      const now = Date.now();
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "First",
        source: "web",
        createdAt: now - 1000,
      });
      repo.create({
        id: "msg-2",
        authorId: "author-1",
        content: "Second",
        source: "web",
        createdAt: now,
      });

      const pending = repo.getNextPending();
      expect(pending).not.toBeNull();
      expect(pending?.id).toBe("msg-1");
    });

    it("should not return processing messages", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "First",
        source: "web",
        createdAt: Date.now(),
      });
      repo.updateStatus("msg-1", "processing");

      const pending = repo.getNextPending();
      expect(pending).toBeNull();
    });

    it("should not return completed messages", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "First",
        source: "web",
        createdAt: Date.now(),
      });
      repo.updateStatus("msg-1", "completed");

      const pending = repo.getNextPending();
      expect(pending).toBeNull();
    });
  });

  describe("updateStatus", () => {
    it("should update message status", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "Test",
        source: "web",
        createdAt: Date.now(),
      });

      repo.updateStatus("msg-1", "processing");

      const message = repo.getById("msg-1");
      expect(message?.status).toBe("processing");
    });

    it("should update status with startedAt timestamp", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "Test",
        source: "web",
        createdAt: Date.now(),
      });

      const startedAt = Date.now();
      repo.updateStatus("msg-1", "processing", { startedAt });

      const message = repo.getById("msg-1");
      expect(message?.status).toBe("processing");
      expect(message?.started_at).toBe(startedAt);
    });

    it("should update status with completedAt timestamp", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "Test",
        source: "web",
        createdAt: Date.now(),
      });

      const completedAt = Date.now();
      repo.updateStatus("msg-1", "completed", { completedAt });

      const message = repo.getById("msg-1");
      expect(message?.status).toBe("completed");
      expect(message?.completed_at).toBe(completedAt);
    });

    it("should update status with error message", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "Test",
        source: "web",
        createdAt: Date.now(),
      });

      repo.updateStatus("msg-1", "failed", { errorMessage: "Something went wrong" });

      const message = repo.getById("msg-1");
      expect(message?.status).toBe("failed");
      expect(message?.error_message).toBe("Something went wrong");
    });
  });

  describe("list", () => {
    beforeEach(() => {
      const now = Date.now();
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "First",
        source: "web",
        createdAt: now - 2000,
      });
      repo.create({
        id: "msg-2",
        authorId: "author-1",
        content: "Second",
        source: "web",
        createdAt: now - 1000,
      });
      repo.create({
        id: "msg-3",
        authorId: "author-1",
        content: "Third",
        source: "web",
        createdAt: now,
      });
      repo.updateStatus("msg-1", "completed");
    });

    it("should return all messages by default", () => {
      const result = repo.list({});
      expect(result.messages).toHaveLength(3);
    });

    it("should apply limit", () => {
      const result = repo.list({ limit: 2 });
      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it("should apply offset", () => {
      const result = repo.list({ offset: 1 });
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].id).toBe("msg-2");
    });

    it("should filter by status", () => {
      const result = repo.list({ status: "pending" });
      expect(result.messages).toHaveLength(2);
      expect(result.messages.every((m) => m.status === "pending")).toBe(true);
    });

    it("should indicate hasMore when more messages exist", () => {
      const result = repo.list({ limit: 2, offset: 0 });
      expect(result.hasMore).toBe(true);
    });

    it("should indicate no more messages when at the end", () => {
      const result = repo.list({ limit: 10, offset: 0 });
      expect(result.hasMore).toBe(false);
    });
  });

  describe("count", () => {
    it("should return 0 when no messages exist", () => {
      expect(repo.count()).toBe(0);
    });

    it("should return correct count", () => {
      repo.create({
        id: "msg-1",
        authorId: "author-1",
        content: "First",
        source: "web",
        createdAt: Date.now(),
      });
      repo.create({
        id: "msg-2",
        authorId: "author-1",
        content: "Second",
        source: "web",
        createdAt: Date.now(),
      });

      expect(repo.count()).toBe(2);
    });
  });
});
