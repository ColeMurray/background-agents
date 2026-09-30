import { describe, expect, it } from "vitest";
import { sandboxEventSchema } from "./sandbox-events";

describe("token sandbox event", () => {
  const token = {
    type: "token",
    content: "text",
    messageId: "msg-1",
    sandboxId: "sb-1",
    timestamp: 1,
  };

  it("preserves a nonempty part ID and accepts tokens from older runtimes", () => {
    expect(sandboxEventSchema.parse({ ...token, partId: "part-1" })).toEqual({
      ...token,
      partId: "part-1",
    });
    expect(sandboxEventSchema.parse(token)).toEqual(token);
  });

  it("rejects an empty part ID", () => {
    expect(sandboxEventSchema.safeParse({ ...token, partId: "" }).success).toBe(false);
  });
});
