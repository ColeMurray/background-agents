import { describe, expect, it } from "vitest";
import { classifyTerminalAcknowledgement } from "./session-read-state";

describe("classifyTerminalAcknowledgement", () => {
  it("acknowledges an accepted cursor", () => {
    expect(
      classifyTerminalAcknowledgement(
        {
          sessionId: "session-1",
          accepted: true,
          unread: false,
          attentionId: "message-1",
        },
        "message-1"
      )
    ).toBe("acknowledged");
  });

  it("retries while the observed cursor has not been projected", () => {
    expect(
      classifyTerminalAcknowledgement(
        {
          sessionId: "session-1",
          accepted: false,
          unread: true,
          attentionId: "message-previous",
        },
        "message-1"
      )
    ).toBe("retry");
  });

  it("stops when the server already represents the observed cursor", () => {
    expect(
      classifyTerminalAcknowledgement(
        {
          sessionId: "session-1",
          accepted: false,
          unread: false,
          attentionId: "message-1",
        },
        "message-1"
      )
    ).toBe("not_applicable");
  });
});
