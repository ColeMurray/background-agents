import { describe, expect, it } from "vitest";
import { formatPendingVmReference, parsePendingVmReference } from "./pending-vm-reference";

describe("pending VM references", () => {
  it("uses the shared two-part wire format", () => {
    const reference = 'modal-vm-session:["session-1","sandbox-1"]';
    expect(formatPendingVmReference("session-1", "sandbox-1")).toBe(reference);
    expect(parsePendingVmReference(reference)).toEqual({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
    });
  });

  it.each([
    "sb-1",
    "modal-vm-session:not-json",
    'modal-vm-session:["session-1"]',
    'modal-vm-session:["session-1","sandbox-1","extra"]',
    'modal-vm-session:["", "sandbox-1"]',
    'modal-vm-session:["session-1", 2]',
    'modal-vm-session:{"sessionId":"session-1","sandboxId":"sandbox-1"}',
  ])("rejects invalid reference %s", (reference) => {
    expect(parsePendingVmReference(reference)).toBeNull();
  });
});
