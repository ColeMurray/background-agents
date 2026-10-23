import { describe, expect, it } from "vitest";
import { createAutomationRequestSchema, updateAutomationRequestSchema } from "./automations";

describe("automation retry configuration", () => {
  it("preserves an opt-in retry budget on create and update", () => {
    expect(
      createAutomationRequestSchema.parse({ name: "Daily", instructions: "Run", maxRetries: 3 })
    ).toMatchObject({ maxRetries: 3 });
    expect(updateAutomationRequestSchema.parse({ maxRetries: 0 })).toEqual({ maxRetries: 0 });
  });

  it.each([-1, 1.5, 6, "2"])("rejects invalid retry budget %s", (maxRetries) => {
    expect(updateAutomationRequestSchema.safeParse({ maxRetries }).success).toBe(false);
  });
});
