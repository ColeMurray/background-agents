import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function runLogs(response: unknown, ...args: string[]) {
  // Exercise the real CLI without credentials or any network requests.
  const preload = `globalThis.fetch = async () => Response.json(${JSON.stringify(response)});`;
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL("./cf-logs.ts", import.meta.url)),
      "--all",
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "test-token",
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        NO_COLOR: "1",
      },
    }
  );
}

function telemetry(events: unknown[]) {
  return { success: true, result: { events: { events } } };
}

describe("Cloudflare logs JSON boundary", () => {
  const event = {
    timestamp: 1_700_000_000_000,
    $metadata: { level: "info", service: "worker", id: "event-id" },
    $workers: { scriptName: "worker", executionModel: "durableObject", outcome: "ok" },
    source: {
      level: "info",
      component: "test",
      msg: "hello",
      session_id: "test-session",
      extra: { n: 1 },
    },
    dataset: "worker-logs",
    links: [{ id: "linked-event" }],
  };

  it("retains unconsumed fields in raw JSON and formats valid logs", () => {
    const raw = runLogs(telemetry([event]), "--json");
    assert.equal(raw.status, 0, raw.stderr);
    assert.deepEqual(JSON.parse(raw.stdout), [event]);
    const formatted = runLogs(telemetry([event]));
    assert.equal(formatted.status, 0, formatted.stderr);
    assert.match(formatted.stdout, /INFO.*worker.*test.*hello/);
    assert.match(formatted.stderr, /Sessions:.*test-session/);
  });

  for (const response of [
    telemetry([]),
    { success: true },
    { success: true, result: {} },
    { success: true, result: { events: {} } },
  ]) {
    it(`preserves an empty optional events result: ${JSON.stringify(response)}`, () => {
      const child = runLogs(response);
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stderr, /No logs found/);
    });
  }

  for (const event of [
    null,
    [],
    42,
    { timestamp: "1700000000000" },
    { timestamp: 1e100 },
    { source: { level: 42 } },
    { source: [] },
    { $metadata: { level: false } },
    { $workers: { scriptName: 42 } },
  ]) {
    it(`rejects malformed events without silently dropping them: ${JSON.stringify(event)}`, () => {
      const child = runLogs(telemetry([event]));
      assert.equal(child.status, 1);
      assert.match(child.stderr, /malformed telemetry events/);
      assert.equal(child.stdout, "");
    });
  }

  for (const response of [
    null,
    { success: "true" },
    { success: true, result: [] },
    { success: true, result: { events: [] } },
    { success: true, result: { events: { events: {} } } },
  ]) {
    it(`rejects malformed response envelopes: ${JSON.stringify(response)}`, () => {
      const child = runLogs(response);
      assert.equal(child.status, 1);
      assert.match(child.stderr, /not a telemetry query result|malformed telemetry events/);
    });
  }

  it("reports API errors with their original diagnostics", () => {
    const child = runLogs({ success: false, errors: [{ message: "query failed" }] });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /API error:.*query failed/);
  });
});
