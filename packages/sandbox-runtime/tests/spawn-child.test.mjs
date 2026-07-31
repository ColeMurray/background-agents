import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildSpawnBody,
  spawnChildArgs,
} from "../src/sandbox_runtime/tools/spawn-child-config.js";

test("spawn-child exposes an optional reasoning argument", () => {
  const result = spawnChildArgs.reasoning.safeParse("high");

  assert.equal(result.success, true);
  assert.match(spawnChildArgs.reasoning.description, /overrides.*parent/i);
  assert.match(spawnChildArgs.reasoning.description, /defaults to.*parent/i);
});

test("buildChildSpawnBody serializes reasoningEffort when supplied", () => {
  assert.deepEqual(
    buildChildSpawnBody({ title: "Investigate", prompt: "Find the bug", reasoning: "high" }),
    {
      title: "Investigate",
      prompt: "Find the bug",
      reasoningEffort: "high",
    }
  );
});

test("buildChildSpawnBody omits reasoningEffort for parent inheritance", () => {
  assert.deepEqual(buildChildSpawnBody({ title: "Investigate", prompt: "Find the bug" }), {
    title: "Investigate",
    prompt: "Find the bug",
  });
});
