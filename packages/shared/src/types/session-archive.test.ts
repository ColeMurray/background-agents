import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_ARCHIVE_BATCH_SIZE,
  sessionBatchArchiveRequestSchema,
} from "./session-archive";

describe("session batch archive request", () => {
  it.each([
    {},
    { sessionIds: [] },
    { sessionIds: [""] },
    { sessionIds: ["  "] },
    { sessionIds: ["one", " one "] },
    { sessionIds: [42] },
    { sessionIds: ["x".repeat(257)] },
    { sessionIds: ["one"], operatorUserId: "spoofed" },
    { cursor: "100:0:" },
    { sessionIds: Array.from({ length: MAX_SESSION_ARCHIVE_BATCH_SIZE + 1 }, (_, i) => String(i)) },
  ])("rejects invalid or ambiguous selection %j", (body) => {
    expect(sessionBatchArchiveRequestSchema.safeParse(body).success).toBe(false);
  });
  it("accepts a bounded explicit selection", () => {
    expect(sessionBatchArchiveRequestSchema.parse({ sessionIds: [" one ", "two"] })).toEqual({
      sessionIds: ["one", "two"],
    });
  });
});
