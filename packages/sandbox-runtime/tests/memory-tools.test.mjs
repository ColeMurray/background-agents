import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTROL_PLANE_URL = "https://control.test";
process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "bound-session" });

const requests = [];
function respondWith(response) {
  requests.length = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return typeof response === "function" ? response() : response.clone();
  };
}

const { executeMemoryTool, memoryToolArgs, memoryToolDefinition } =
  await import("../src/sandbox_runtime/tools/_memory.js");
const { MEMORY_CONTRACT } = await import("../src/sandbox_runtime/tools/_memory-contract.js");

/** Records the zod builder calls the converter makes; the plugin's zod is not installed here. */
function recordingSchema() {
  const node = (calls) =>
    new Proxy(
      { calls },
      {
        get: (target, method) =>
          method === "calls"
            ? target.calls
            : (...args) => node([...target.calls, [method, ...args]]),
      }
    );
  return {
    string: () => node([["string"]]),
    number: () => node([["number"]]),
    enum: (values) => node([["enum", values]]),
  };
}

test("converter maps string, enum, and integer constraints onto the plugin schema", () => {
  const args = memoryToolArgs(recordingSchema(), {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2, maxLength: 256, description: "Keywords" },
      scopeType: { type: "string", enum: ["personal", "repository"] },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  });

  assert.deepEqual(args.query.calls, [
    ["string"],
    ["min", 2],
    ["max", 256],
    ["describe", "Keywords"],
  ]);
  assert.deepEqual(args.scopeType.calls, [["enum", ["personal", "repository"]], ["optional"]]);
  assert.deepEqual(args.limit.calls, [
    ["number"],
    ["int"],
    ["min", 1],
    ["max", 20],
    ["default", 10],
    ["optional"],
  ]);
});

test("converter rejects schema types it does not understand", () => {
  assert.throws(
    () =>
      memoryToolArgs(recordingSchema(), {
        type: "object",
        properties: { tags: { type: "array" } },
      }),
    /Unsupported memory tool argument type for tags: array/
  );
});

test("every generated spec converts and exposes its description", () => {
  for (const spec of MEMORY_CONTRACT.tools) {
    const definition = memoryToolDefinition(recordingSchema(), spec.name);
    assert.equal(definition.description, spec.description);
    assert.deepEqual(Object.keys(definition.args), Object.keys(spec.inputSchema.properties));
  }
});

test("memory_read fills the encoded path parameter and sends no body", async () => {
  respondWith(Response.json({ id: "mem/a", status: "active" }));

  const output = await executeMemoryTool("memory_read", { memoryId: "mem/a b" });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://control.test/sessions/bound-session/sandbox-memory/mem%2Fa%20b"
  );
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.headers.get("Authorization"), "Bearer sandbox-token");
  assert.deepEqual(JSON.parse(output), { id: "mem/a", status: "active" });
});

test("memory_write sends the flat arguments without caller identity", async () => {
  respondWith(Response.json({ status: "proposed" }, { status: 201 }));
  const declared = {
    scopeType: "repository",
    repoOwner: "group/subgroup",
    repoName: "api",
    memoryType: "fact",
    title: "Test setup",
    description: "Start the database",
    content: "Body",
  };

  const output = await executeMemoryTool("memory_write", {
    ...declared,
    supersedesMemoryId: undefined,
    ownerUserId: "attacker",
    sessionId: "other",
    environmentId: "other",
  });

  assert.equal(requests[0].url, "https://control.test/sessions/bound-session/sandbox-memory");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), declared);
  assert.deepEqual(JSON.parse(output), { status: "proposed" });
});

test("memory_search forwards declared filters only", async () => {
  respondWith(Response.json({ results: [], hasMore: false }));

  await executeMemoryTool("memory_search", {
    query: "billing webhook",
    limit: 5,
    ownerUserId: "attacker",
    environmentId: "other",
    sessionId: "other",
  });

  assert.equal(
    requests[0].url,
    "https://control.test/sessions/bound-session/sandbox-memory/search"
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), { query: "billing webhook", limit: 5 });
});

test("memory tools report HTTP failures with the server's error message", async () => {
  respondWith(
    Response.json({ error: "Personal memory is excluded from this session" }, { status: 403 })
  );

  const output = await executeMemoryTool("memory_read", { memoryId: "mem_denied" });

  assert.equal(output, "memory_read failed (403): Personal memory is excluded from this session");
});

test("memory tools conceal transport failure details", async () => {
  respondWith(() => {
    throw new Error("connect ECONNREFUSED 10.0.0.1");
  });

  const output = await executeMemoryTool("memory_search", { query: "billing" });

  assert.equal(output, "memory_search failed (unavailable)");
});
