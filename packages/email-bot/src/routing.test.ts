import { describe, expect, it } from "vitest";
import {
  extractEmailAddress,
  normalizeAgentMailMessage,
  parseRoutesConfig,
  resolveEmailRoute,
} from "./routing";

describe("email routing", () => {
  it("extracts email addresses from display-name senders", () => {
    expect(extractEmailAddress("Lawrence Tan <Lawrence_Tan@spi.edu.sg>")).toBe(
      "lawrence_tan@spi.edu.sg"
    );
  });

  it("routes generic agent inbox by whitelisted sender domain", () => {
    const config = parseRoutesConfig(
      JSON.stringify({
        routes: [
          {
            id: "spi-training-content",
            clientId: "spi",
            repoOwner: "taskark",
            repoName: "spi",
            recipientAddresses: ["agent@taskark.com"],
            allowedDomains: ["spi.edu.sg", "sp.edu.sg"],
          },
        ],
      })
    );

    const message = normalizeAgentMailMessage({
      event_type: "message.received",
      message: {
        inbox_id: "inbox_1",
        thread_id: "thread_1",
        message_id: "msg_1",
        from: "Lawrence Tan <lawrence_tan@spi.edu.sg>",
        to: ["agent@taskark.com"],
        subject: "Update slides",
        text: "Please update the deck.",
      },
    });

    expect(resolveEmailRoute(config, message)).toMatchObject({
      ok: true,
      route: { id: "spi-training-content" },
    });
  });

  it("does not route unlisted senders", () => {
    const config = parseRoutesConfig(
      JSON.stringify({
        routes: [
          {
            id: "spi-training-content",
            clientId: "spi",
            repoOwner: "taskark",
            repoName: "spi",
            recipientAddresses: ["agent@taskark.com"],
            allowedSenders: ["lawrence_tan@spi.edu.sg"],
          },
        ],
      })
    );

    const message = normalizeAgentMailMessage({
      event_type: "message.received",
      message: {
        inbox_id: "inbox_1",
        thread_id: "thread_1",
        message_id: "msg_1",
        from: "unknown@example.com",
        to: ["agent@taskark.com"],
        subject: "Update slides",
        text: "Please update the deck.",
      },
    });

    expect(resolveEmailRoute(config, message)).toEqual({ ok: false, reason: "no_match" });
  });

  it("rejects ambiguous routes instead of guessing", () => {
    const config = parseRoutesConfig(
      JSON.stringify({
        routes: [
          {
            id: "spi-a",
            clientId: "spi",
            repoOwner: "taskark",
            repoName: "spi",
            allowedDomains: ["spi.edu.sg"],
          },
          {
            id: "spi-b",
            clientId: "spi",
            repoOwner: "taskark",
            repoName: "spi",
            allowedDomains: ["spi.edu.sg"],
          },
        ],
      })
    );

    const message = normalizeAgentMailMessage({
      event_type: "message.received",
      message: {
        inbox_id: "inbox_1",
        thread_id: "thread_1",
        message_id: "msg_1",
        from: "lawrence_tan@spi.edu.sg",
        to: ["agent@taskark.com"],
        text: "Please update the deck.",
      },
    });

    expect(resolveEmailRoute(config, message)).toMatchObject({
      ok: false,
      reason: "ambiguous",
    });
  });
});
