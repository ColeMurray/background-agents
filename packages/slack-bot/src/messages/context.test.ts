import { describe, expect, it } from "vitest";
import { formatChannelContext, formatThreadContext } from "./context";

describe("message context", () => {
  it("formats thread messages with the prompt delimiter", () => {
    expect(formatThreadContext(["[Ada]: First", "[Bot]: Second"])).toBe(
      "Context from the Slack thread:\n---\n[Ada]: First\n[Bot]: Second\n---\n\n"
    );
  });

  it("omits empty thread context", () => {
    expect(formatThreadContext([])).toBe("");
  });

  it("formats channel context with an optional description", () => {
    expect(formatChannelContext("engineering", "Build discussion")).toBe(
      "Slack channel context:\n---\nChannel: #engineering\nDescription: Build discussion\n---\n\n"
    );
    expect(formatChannelContext("engineering")).toBe(
      "Slack channel context:\n---\nChannel: #engineering\n---\n\n"
    );
  });
});
