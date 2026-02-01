/**
 * Tests for EventRepository implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";
import { createEventRepository } from "./event-repository";
import { initSchema } from "../schema";
import type { EventRepository } from "./types";

describe("EventRepository", () => {
  let sql: FakeSqlStorage;
  let repo: EventRepository;

  beforeEach(() => {
    sql = new FakeSqlStorage();
    initSchema(sql as unknown as SqlStorage);
    repo = createEventRepository(sql as unknown as SqlStorage);
  });

  describe("create", () => {
    it("should create a new event", () => {
      const now = Date.now();
      const event = repo.create({
        id: "event-1",
        type: "tool_call",
        data: JSON.stringify({ tool: "Read", args: {} }),
        createdAt: now,
      });

      expect(event.id).toBe("event-1");
      expect(event.type).toBe("tool_call");
      expect(event.data).toBe(JSON.stringify({ tool: "Read", args: {} }));
      expect(event.created_at).toBe(now);
      expect(event.message_id).toBeNull();
    });

    it("should create an event with message ID", () => {
      const event = repo.create({
        id: "event-1",
        type: "token",
        data: JSON.stringify({ text: "Hello" }),
        messageId: "msg-1",
        createdAt: Date.now(),
      });

      expect(event.message_id).toBe("msg-1");
    });
  });

  describe("getById", () => {
    it("should return null when event does not exist", () => {
      const event = repo.getById("nonexistent");
      expect(event).toBeNull();
    });

    it("should return event when it exists", () => {
      repo.create({
        id: "event-1",
        type: "tool_call",
        data: "{}",
        createdAt: Date.now(),
      });

      const event = repo.getById("event-1");
      expect(event).not.toBeNull();
      expect(event?.id).toBe("event-1");
    });
  });

  describe("list", () => {
    beforeEach(() => {
      const now = Date.now();
      repo.create({
        id: "event-1",
        type: "tool_call",
        data: "{}",
        messageId: "msg-1",
        createdAt: now - 2000,
      });
      repo.create({
        id: "event-2",
        type: "token",
        data: "{}",
        messageId: "msg-1",
        createdAt: now - 1000,
      });
      repo.create({
        id: "event-3",
        type: "git_sync",
        data: "{}",
        createdAt: now,
      });
    });

    it("should return all events by default", () => {
      const events = repo.list({});
      expect(events).toHaveLength(3);
    });

    it("should apply limit", () => {
      const events = repo.list({ limit: 2 });
      expect(events).toHaveLength(2);
    });

    it("should filter by message ID", () => {
      const events = repo.list({ messageId: "msg-1" });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.message_id === "msg-1")).toBe(true);
    });

    it("should filter by event types", () => {
      const events = repo.list({ types: ["tool_call", "token"] });
      expect(events).toHaveLength(2);
      expect(events.some((e) => e.type === "tool_call")).toBe(true);
      expect(events.some((e) => e.type === "token")).toBe(true);
      expect(events.some((e) => e.type === "git_sync")).toBe(false);
    });

    it("should return events ordered by created_at ascending", () => {
      const events = repo.list({});
      expect(events[0].id).toBe("event-1");
      expect(events[1].id).toBe("event-2");
      expect(events[2].id).toBe("event-3");
    });

    it("should combine filters", () => {
      const events = repo.list({
        messageId: "msg-1",
        types: ["token"],
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("token");
    });
  });
});
