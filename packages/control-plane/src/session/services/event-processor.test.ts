/**
 * Tests for EventProcessor service.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createEventProcessor } from "./event-processor";
import type { EventProcessor } from "./types";
import type { EventRepository } from "../repository/types";
import { createEventRepository } from "../repository";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";

describe("EventProcessor", () => {
  let processor: EventProcessor;
  let eventRepo: EventRepository;
  let mockBroadcast: Mock;
  let mockOnExecutionComplete: Mock;
  let mockOnProcessNextMessage: Mock;
  let mockTriggerSnapshot: Mock;
  let sql: FakeSqlStorage;

  beforeEach(() => {
    sql = new FakeSqlStorage();
    sql.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data TEXT,
        message_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    eventRepo = createEventRepository(sql);
    mockBroadcast = vi.fn();
    mockOnExecutionComplete = vi.fn().mockResolvedValue(undefined);
    mockOnProcessNextMessage = vi.fn().mockResolvedValue(undefined);
    mockTriggerSnapshot = vi.fn().mockResolvedValue(undefined);

    processor = createEventProcessor({
      eventRepo,
      broadcast: mockBroadcast,
      callbacks: {
        onExecutionComplete: mockOnExecutionComplete,
        onProcessNextMessage: mockOnProcessNextMessage,
        triggerSnapshot: mockTriggerSnapshot,
      },
    });
  });

  describe("processEvent", () => {
    it("should store event in repository", async () => {
      const event = {
        type: "test_event",
        data: { value: "test" },
      };

      await processor.processEvent(event);

      const events = eventRepo.list({});
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("test_event");
      expect(events[0].data).toBe(JSON.stringify({ value: "test" }));
    });

    it("should broadcast event to clients", async () => {
      const event = {
        type: "test_event",
        data: { value: "test" },
      };

      await processor.processEvent(event);

      expect(mockBroadcast).toHaveBeenCalledWith({
        type: "event",
        event: expect.objectContaining({
          id: expect.any(String),
          type: "test_event",
          data: { value: "test" },
          createdAt: expect.any(Number),
        }),
      });
    });

    it("should include message_id when provided", async () => {
      const event = {
        type: "test_event",
        data: { value: "test" },
        message_id: "msg-1",
      };

      await processor.processEvent(event);

      const events = eventRepo.list({});
      expect(events[0].message_id).toBe("msg-1");
    });

    it("should handle event without data field", async () => {
      const event = {
        type: "simple_event",
      };

      await processor.processEvent(event);

      const events = eventRepo.list({});
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("simple_event");
      expect(events[0].data).toBeNull();
    });
  });

  describe("execution_complete event", () => {
    it("should trigger onExecutionComplete callback for success", async () => {
      const event = {
        type: "execution_complete",
        data: {
          message_id: "msg-1",
          success: true,
        },
        message_id: "msg-1",
      };

      await processor.processEvent(event);

      expect(mockOnExecutionComplete).toHaveBeenCalledWith("msg-1", true);
    });

    it("should trigger onExecutionComplete callback for failure", async () => {
      const event = {
        type: "execution_complete",
        data: {
          message_id: "msg-2",
          success: false,
        },
        message_id: "msg-2",
      };

      await processor.processEvent(event);

      expect(mockOnExecutionComplete).toHaveBeenCalledWith("msg-2", false);
    });

    it("should trigger onProcessNextMessage after execution complete", async () => {
      const event = {
        type: "execution_complete",
        data: {
          message_id: "msg-1",
          success: true,
        },
        message_id: "msg-1",
      };

      await processor.processEvent(event);

      expect(mockOnProcessNextMessage).toHaveBeenCalled();
    });

    it("should handle execution_complete without message_id", async () => {
      const event = {
        type: "execution_complete",
        data: {
          success: true,
        },
      };

      await processor.processEvent(event);

      expect(mockOnExecutionComplete).not.toHaveBeenCalled();
      expect(mockOnProcessNextMessage).not.toHaveBeenCalled();
    });
  });

  describe("git_sync event", () => {
    it("should trigger snapshot on git_sync event", async () => {
      const event = {
        type: "git_sync",
        data: { status: "synced" },
      };

      await processor.processEvent(event);

      expect(mockTriggerSnapshot).toHaveBeenCalledWith("git_sync");
    });
  });

  describe("heartbeat event", () => {
    it("should trigger snapshot on heartbeat event", async () => {
      const event = {
        type: "heartbeat",
        data: { timestamp: Date.now() },
      };

      await processor.processEvent(event);

      expect(mockTriggerSnapshot).toHaveBeenCalledWith("heartbeat");
    });
  });

  describe("push_complete event", () => {
    it("should trigger snapshot on push_complete", async () => {
      const event = {
        type: "push_complete",
        data: { branch: "main" },
      };

      await processor.processEvent(event);

      expect(mockTriggerSnapshot).toHaveBeenCalledWith("push_complete");
    });
  });

  describe("push_error event", () => {
    it("should trigger snapshot on push_error", async () => {
      const event = {
        type: "push_error",
        data: { error: "Push failed" },
      };

      await processor.processEvent(event);

      expect(mockTriggerSnapshot).toHaveBeenCalledWith("push_error");
    });
  });

  describe("error handling", () => {
    it("should handle broadcast errors gracefully", async () => {
      mockBroadcast.mockImplementation(() => {
        throw new Error("Broadcast failed");
      });

      const event = {
        type: "test_event",
        data: { value: "test" },
      };

      await expect(processor.processEvent(event)).resolves.not.toThrow();

      // Event should still be stored
      const events = eventRepo.list({});
      expect(events).toHaveLength(1);
    });

    it("should handle callback errors gracefully", async () => {
      mockOnExecutionComplete.mockRejectedValue(new Error("Callback failed"));

      const event = {
        type: "execution_complete",
        data: {
          message_id: "msg-1",
          success: true,
        },
        message_id: "msg-1",
      };

      await expect(processor.processEvent(event)).resolves.not.toThrow();

      // Event should still be stored
      const events = eventRepo.list({});
      expect(events).toHaveLength(1);
    });
  });
});
