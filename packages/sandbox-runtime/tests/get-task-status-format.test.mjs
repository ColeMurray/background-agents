import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildDetailQuery,
  formatFinalResponse,
  formatRecentEvents,
  formatTrajectory,
  summarizeEvent,
} from "../src/sandbox_runtime/tools/get-task-status-format.js";

test("buildChildDetailQuery includes only result when response is requested", () => {
  assert.equal(buildChildDetailQuery({ includeResponse: true }), "?include=result");
});

test("buildChildDetailQuery includes trajectory pagination parameters", () => {
  assert.equal(
    buildChildDetailQuery({
      includeTrajectory: true,
      trajectoryLimit: 25,
      trajectoryCursor: "10:event:1",
    }),
    "?include=result%2Ctrajectory&trajectoryLimit=25&trajectoryCursor=10%3Aevent%3A1"
  );
});

test("formatFinalResponse shows capped event count and tool summaries", () => {
  const output = formatFinalResponse(
    {
      success: true,
      textContent: "done",
      toolCalls: [{ tool: "Bash", summary: "Ran: npm test" }],
      eventCount: 1000,
      eventLimitReached: true,
    },
    true
  ).join("\n");

  assert.match(output, /Events: 1000 \(limit reached\)/);
  assert.match(output, /done/);
  assert.match(output, /Ran: npm test/);
});

test("formatTrajectory shows event summaries and pagination cursor", () => {
  const output = formatTrajectory({
    hasMore: true,
    cursor: "30:event-1",
    events: [
      {
        id: "event-1",
        type: "tool_call",
        messageId: "message-1",
        createdAt: 1000,
        data: { tool: "Bash", args: { command: "npm test" } },
      },
    ],
  }).join("\n");

  assert.match(output, /Bash: npm test/);
  assert.match(output, /More events available/);
  assert.match(output, /trajectoryCursor="30:event-1"/);
});

test("formatRecentEvents summarizes message-like payloads", () => {
  const output = formatRecentEvents([
    { type: "error", createdAt: 1000, data: { message: "boom" } },
  ]).join("\n");

  assert.match(output, /error: boom/);
});

test("summarizeEvent falls back to common data fields", () => {
  assert.equal(summarizeEvent({ type: "progress", data: { state: "running" } }), "running");
});
