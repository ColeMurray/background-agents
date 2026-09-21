import assert from "node:assert/strict";
import test from "node:test";
import { waitForChildren } from "../src/sandbox_runtime/tools/_wait-for-children.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function detail(id, text) {
  return {
    session: { id, title: id, status: "completed", model: "openai/gpt-5.6-sol" },
    artifacts: [],
    recentEvents: [],
    finalResponse: { success: true, textContent: text },
  };
}

test("waits for every named child and returns final responses", async () => {
  let listCalls = 0;
  let nowMs = 0;
  const paths = [];
  const request = async (path) => {
    paths.push(path);
    if (path === "/children") {
      listCalls++;
      return jsonResponse({
        children: [
          { id: "c1", status: listCalls === 1 ? "active" : "completed" },
          { id: "c2", status: "completed" },
        ],
      });
    }
    if (path.includes("c1")) return jsonResponse(detail("c1", "first result"));
    return jsonResponse(detail("c2", "second result"));
  };

  const output = await waitForChildren(
    { childIds: ["c1", "c2"], timeoutSeconds: 10 },
    {
      request,
      now: () => nowMs,
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
    }
  );

  assert.match(output, /All 2 child session\(s\) reached terminal states/);
  assert.match(output, /first result/);
  assert.match(output, /second result/);
  assert.deepEqual(paths, [
    "/children",
    "/children",
    "/children/c1?include=result",
    "/children/c2?include=result",
  ]);
});

test("rejects an ID that is not a direct child", async () => {
  let slept = false;
  const output = await waitForChildren(
    { childIds: ["missing"], timeoutSeconds: 10 },
    {
      request: async () => jsonResponse({ children: [] }),
      sleep: async () => {
        slept = true;
      },
      now: () => 0,
    }
  );

  assert.equal(output, "Cannot wait for unknown direct child session(s): missing");
  assert.equal(slept, false);
});

test("times out without cancelling an active child", async () => {
  let nowMs = 0;
  const output = await waitForChildren(
    { childIds: ["c1"], timeoutSeconds: 1 },
    {
      request: async () => jsonResponse({ children: [{ id: "c1", status: "active" }] }),
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
      now: () => nowMs,
    }
  );

  assert.match(output, /Timed out after 1s/);
  assert.match(output, /\[RUNNING\] c1/);
  assert.match(output, /same IDs/);
});
