import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildDetailQuery,
  formatChildDetail,
  formatFinalResponse,
  formatRecentEvents,
  formatTrajectory,
  summarizeEvent,
} from "../src/sandbox_runtime/tools/get-child-status-format.js";

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
    "?include=trajectory&trajectoryLimit=25&trajectoryCursor=10%3Aevent%3A1"
  );
});

test("buildChildDetailQuery keeps response and trajectory includes separate", () => {
  assert.equal(
    buildChildDetailQuery({
      includeResponse: true,
      includeTrajectory: true,
    }),
    "?include=result%2Ctrajectory"
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

test("formatChildDetail does not show final response placeholder for trajectory-only requests", () => {
  const output = formatChildDetail(
    {
      session: {
        id: "task-1",
        title: "Trajectory only",
        status: "completed",
      },
      trajectory: {
        hasMore: false,
        events: [{ type: "execution_complete", createdAt: 1000, data: { success: true } }],
      },
    },
    "task-1",
    { includeTrajectory: true }
  );

  assert.doesNotMatch(output, /Final response/);
  assert.match(output, /Trajectory/);
});

test("formatChildDetail labels an older response while a follow-up is active", () => {
  const output = formatChildDetail(
    {
      session: {
        id: "task-1",
        title: "Resumed task",
        status: "active",
      },
      finalResponse: {
        success: true,
        textContent: "previous answer",
      },
      hasUnfinishedPrompt: true,
    },
    "task-1",
    { includeResponse: true }
  );

  assert.match(output, /Latest completed response \(newer prompt queued or running\)/);
  assert.doesNotMatch(output, /Final response:/);
});

test("formatChildDetail does not claim work is running from session status alone", () => {
  const output = formatChildDetail(
    {
      session: { id: "task-1", title: "Idle active task", status: "active" },
      finalResponse: { success: true, textContent: "previous answer" },
      hasUnfinishedPrompt: false,
    },
    "task-1",
    { includeResponse: true }
  );

  assert.match(output, /Final response:/);
  assert.doesNotMatch(output, /current prompt still running/);
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

const protectedFiles = [
  { id: "shot-1", type: "screenshot", caption: "Dashboard" },
  { id: "video-1", type: "video", caption: "Walkthrough" },
  {
    id: "csv-1",
    type: "file",
    available: true,
    metadata: {
      filename: "report.csv",
      caption: "Revenue",
      objectKey: "sessions/private/files/csv-1",
    },
  },
  { id: "missing-1", type: "file", available: false },
];

for (const collection of ["fileArtifacts", "mediaArtifacts"]) {
  test(`child formatter renders completion ${collection} without storage keys`, () => {
    const output = formatChildDetail(
      { finalResponse: { success: true, [collection]: protectedFiles } },
      "c1",
      { includeResponse: true }
    );
    for (const text of [
      "shot-1",
      "screenshot",
      "Dashboard",
      "video-1",
      "Walkthrough",
      "csv-1",
      "report.csv",
      "Revenue",
      "missing-1",
      "unavailable",
    ]) {
      assert.ok(output.includes(text), text);
    }
    assert.ok(!output.includes("sessions/private"));
  });
}

test("canonical empty collection suppresses legacy completion references", () => {
  const output = formatChildDetail(
    { finalResponse: { fileArtifacts: [], mediaArtifacts: protectedFiles } },
    "c1"
  );
  assert.ok(!output.includes("shot-1"));
});

test("ordinary child status renders safe output summaries without a final response", () => {
  const output = formatChildDetail(
    {
      fileArtifacts: [
        { id: "shot-1", type: "screenshot", caption: "Dashboard" },
        { id: "csv-1", type: "file", filename: "report.csv", available: true },
      ],
    },
    "c1"
  );
  for (const text of ["shot-1", "screenshot", "Dashboard", "csv-1", "report.csv"])
    assert.ok(output.includes(text));
});

test("child status output envelopes retain readable output without private metadata", async () => {
  const { childStatusListOutput, childStatusDetailOutput } =
    await import("../src/sandbox_runtime/tools/get-child-status-format.js");
  const session = {
    id: "child-1",
    title: "Test child",
    status: "completed",
    repoOwner: "acme/team",
    repoName: "web",
    createdAt: 1000,
    secret: "private",
  };
  const list = JSON.parse(childStatusListOutput([session], "1 child session"));
  assert.equal(list.kind, "list");
  assert.equal(list.children[0].id, "child-1");
  assert.equal(list.children[0].repoOwner, "acme/team");
  const detail = {
    session,
    hasUnfinishedPrompt: true,
    finalResponse: {
      success: false,
      error: "Test failed",
      textContent: "## Test results",
      eventCount: 1000,
      eventLimitReached: true,
      fileArtifacts: protectedFiles,
    },
    trajectory: { events: [], hasMore: true, cursor: "next-page" },
  };
  const raw = childStatusDetailOutput(detail, "child-1", { includeResponse: true });
  const result = JSON.parse(raw);
  assert.equal(result.kind, "detail");
  assert.equal(result.hasUnfinishedPrompt, true);
  assert.equal(result.finalResponse.textContent, "## Test results");
  assert.equal(result.finalResponse.success, false);
  assert.equal(result.finalResponse.error, "Test failed");
  assert.equal(result.finalResponse.eventLimitReached, true);
  assert.match(result.agentMessage, /Latest completed response/);
  assert.match(result.agentMessage, /next-page/);
  assert.match(result.agentMessage, /report.csv/);
  assert.ok(!raw.includes("objectKey"));
  assert.ok(!raw.includes("sessions/private"));
  assert.ok(!raw.includes('"secret"'));
  assert.ok(!childStatusListOutput([session], "list").includes('"secret"'));
  assert.deepEqual(JSON.parse(childStatusListOutput([], "No child sessions found.")), {
    version: 1,
    kind: "list",
    children: [],
    agentMessage: "No child sessions found.",
  });
  assert.equal(JSON.parse(childStatusDetailOutput({ session }, "child-1")).finalResponse, null);
});
