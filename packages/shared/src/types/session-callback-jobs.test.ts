import { describe, expect, it } from "vitest";
import { sessionCallbackJobSchema } from "./session-callback-jobs";

const job = {
  version: 1,
  type: "linear.started",
  payload: {
    sessionId: "s",
    messageId: "m",
    timestamp: 1000,
    context: {
      source: "linear",
      issueId: "i",
      issueIdentifier: "ENG-1",
      issueUrl: "https://linear.app/i",
      model: "model",
    },
  },
};

describe("persisted session callback jobs", () => {
  it("round trips a versioned unsigned start event", () => {
    expect(sessionCallbackJobSchema.parse(JSON.parse(JSON.stringify(job)))).toEqual(job);
  });
  it.each([
    { ...job, version: 2 },
    { ...job, type: "unknown" },
    { ...job, destinationUrl: "https://attacker.example" },
    { ...job, payload: { ...job.payload, signature: "signed-by-producer" } },
    { ...job, payload: { ...job.payload, timestamp: Infinity } },
    {
      ...job,
      payload: {
        ...job.payload,
        context: { ...job.payload.context, transitionIssueOnStart: true },
      },
    },
    { ...job, type: "slack.completed" },
  ])("rejects invalid or cross-destination envelope %j", (input) => {
    expect(sessionCallbackJobSchema.safeParse(input).success).toBe(false);
  });
});
