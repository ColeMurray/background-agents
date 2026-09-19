/** Opt-in, billable live test. Uses only newly allocated Sandbox0 resources.
 * Build: npx esbuild packages/control-plane/scripts/smoke-sandbox0.ts --bundle
 *   --platform=node --format=esm --outfile=/tmp/oi-sandbox0-smoke.mjs
 * Run with SANDBOX0_API_KEY and SANDBOX0_TEMPLATE_ID in the environment.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Sandbox0RestClient, sandbox0Path } from "../src/sandbox/sandbox0-rest-client";
import { Sandbox0SandboxProvider } from "../src/sandbox/providers/sandbox0-provider";

const apiKey = process.env.SANDBOX0_API_KEY;
const templateId = process.env.SANDBOX0_TEMPLATE_ID;
assert(apiKey && templateId, "SANDBOX0_API_KEY and SANDBOX0_TEMPLATE_ID are required");
const apiUrl = process.env.SANDBOX0_API_URL || "https://api.sandbox0.ai";
const client = new Sandbox0RestClient({ apiKey, apiUrl });
const request = client.request.bind(client);
const token = randomUUID();
const sandboxId = `oi-test-${randomUUID()}`;
let allocated: string | undefined;

// A loopback protocol fixture exercises the real Python bridge and OpenCode
// without exposing a test control plane or requiring an LLM/GitHub credential.
// It deliberately does not claim to exercise a real model or the web UI.
const fixture = `import asyncio, json, os
from pathlib import Path
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

async def process_request(connection, request):
    if request.headers.get('Authorization') != 'Bearer ' + os.environ['TEST_TOKEN']:
        return Response(401, 'Unauthorized', Headers(), b'Unauthorized')
    if request.headers.get('Upgrade', '').lower() == 'websocket':
        return None
    if '/commit-signing' in request.path:
        payload = {'enabled': False}
    elif '/sandbox-skills' in request.path:
        payload = {'schemaVersion': 1, 'manifestSha256': '0' * 64, 'skills': []}
    else:
        return Response(404, 'Not Found', Headers(), b'Not Found')
    return Response(200, 'OK', Headers({'Content-Type': 'application/json'}), json.dumps(payload).encode())

async def handler(ws):
    async for raw in ws:
        event = json.loads(raw)
        with Path('/workspace/oi-live-events.jsonl').open('a') as output:
            output.write(json.dumps(event) + '\\n')

async def main():
    async with serve(handler, '127.0.0.1', 9999, process_request=process_request):
        await asyncio.Future()
asyncio.run(main())
`;

async function file(id: string, path: string, data?: string): Promise<string> {
  const response = await fetch(
    `${apiUrl}${sandbox0Path(id)}/files?path=${encodeURIComponent(path)}`,
    {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/octet-stream" },
      ...(data === undefined ? {} : { body: data }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  );
  assert(response.ok, `File API failed: ${response.status}`);
  return response.text();
}

async function command(id: string, command: string[]) {
  const context = await request<{ exit_code: number; stdout?: string; output_raw?: string }>(
    "POST",
    `${sandbox0Path(id)}/contexts`,
    {
      type: "cmd",
      cmd: { command },
      wait_until_done: true,
      ttl_sec: 60,
    }
  );
  assert.equal(context.exit_code, 0, "Guest command must exit successfully");
  return context.stdout ?? context.output_raw ?? "";
}

async function waitForReady(id: string, count: number) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const events = (await file(id, "/workspace/oi-live-events.jsonl"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const ready = events.filter((event) => event.type === "ready");
      if (ready.length >= count) {
        assert.equal(ready.at(-1).sandboxId, sandboxId);
        assert(ready.at(-1).runtimeVersion, "Template must report its baked runtime version");
        return;
      }
      assert(!events.some((event) => event.type === "error"), "Runtime reported an error");
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("File API failed: 404")))
        throw error;
    }
    const { sessions } = await request<{
      sessions: Array<{ phase: string; spec: { name: string } }>;
    }>("GET", `${sandbox0Path(id)}/sessions`);
    assert(
      !sessions.some(
        (session) => session.spec.name === "openinspect-runtime" && session.phase === "exited"
      ),
      "Runtime exited before readiness"
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Runtime did not report ready within three minutes");
}

// Insert the loopback fixture after allocation, before the actual provider launch.
client.request = async <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: Parameters<typeof request>[3]
): Promise<T> => {
  const result = await request<T>(method, path, body, options);
  if (method === "POST" && path === "/api/v1/sandboxes") {
    const id = (result as { sandbox_id: string }).sandbox_id;
    allocated = id;
    // Bound test retention independently of the provider's durable production policy.
    await request("PUT", sandbox0Path(id), { config: { hard_ttl: 1800 } });
    await file(id, "/opt/openinspect/oi-live-cp.py", fixture);
    await request("POST", `${sandbox0Path(id)}/sessions`, {
      name: "oi-test-control-plane",
      command: ["/opt/openinspect/python/bin/python", "/opt/openinspect/oi-live-cp.py"],
      env: { TEST_TOKEN: token },
      lifecycle: { desired_state: "running", runtime_recovery: "restart" },
    });
  } else if (method === "POST" && path.endsWith("/resume")) {
    // A real control plane is external to the guest; restart this loopback
    // fixture explicitly after every pause before the provider boots its bridge.
    const sessionsPath = path.replace(/\/resume$/, "/sessions");
    const { sessions } = await request<{
      sessions: Array<{
        id: string;
        phase: string;
        spec: { name: string; lifecycle: Record<string, unknown> };
      }>;
    }>("GET", sessionsPath);
    const fixtureSession = sessions.find(
      (session) => session.spec.name === "oi-test-control-plane"
    );
    assert(fixtureSession);
    if (fixtureSession.phase !== "running") {
      await request("PUT", `${sessionsPath}/${fixtureSession.id}`, {
        ...fixtureSession.spec,
        lifecycle: { ...fixtureSession.spec.lifecycle, desired_state: "running" },
      });
    }
  }
  return result;
};

const provider = new Sandbox0SandboxProvider(client, {
  templateId,
  scmProvider: "github",
  sandboxAccessPasswordSecret: token,
});
try {
  const created = await provider.createSandbox({
    sessionId: "live-test",
    sandboxId,
    repoOwner: null,
    repoName: null,
    harness: "opencode",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    controlPlaneUrl: "http://127.0.0.1:9999",
    sandboxAuthToken: token,
    codeServerEnabled: true,
    vncEnabled: true,
    timeoutSeconds: 600,
  });
  assert(allocated);
  console.log("Created isolated workspace", allocated);
  await waitForReady(allocated, 1);
  assert(created.codeServerUrl && created.codeServerPassword && created.vncAccess);
  const editor = await fetch(created.codeServerUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(editor.status, 302, "Unauthenticated editor must redirect to login");
  assert(editor.headers.get("location")?.includes("login"));
  const desktop = await fetch(created.vncAccess.url, { signal: AbortSignal.timeout(15_000) });
  assert.equal(desktop.status, 200, "Desktop HTTP endpoint must respond");
  await command(allocated, [
    "bash",
    "-lc",
    "mkdir -p /workspace/oi-persistence && cd /workspace/oi-persistence && git init -q && git config user.name Test && git config user.email test@example.invalid && touch tracked && git add tracked && git commit -qm initial",
  ]);
  await file(allocated, "/workspace/oi-persistence/tracked", "uncommitted changes\n");
  await file(allocated, "/tmp/oi-ephemeral", "runtime only");
  for (let cycle = 0; cycle < 2; cycle++) {
    const before = await request<{ runtime_id: string }>("GET", sandbox0Path(allocated));
    await provider.stopSandbox({
      providerObjectId: allocated,
      sessionId: "live-test",
      reason: "inactivity_timeout",
    });
    const paused = await request<{ status: string }>("GET", sandbox0Path(allocated));
    assert.equal(paused.status, "paused");
    const resumed = await provider.resumeSandbox({
      providerObjectId: allocated,
      sessionId: "live-test",
      sandboxId,
      codeServerEnabled: true,
      vncEnabled: true,
      timeoutSeconds: 600,
    });
    assert.equal(resumed.providerObjectId, allocated);
    assert.equal(resumed.codeServerPassword, created.codeServerPassword);
    const after = await request<{ runtime_id: string }>("GET", sandbox0Path(allocated));
    assert.notEqual(after.runtime_id, before.runtime_id);
    await waitForReady(allocated, cycle + 2);
    assert.equal(
      await file(allocated, "/workspace/oi-persistence/tracked"),
      "uncommitted changes\n"
    );
    await command(allocated, [
      "bash",
      "-lc",
      'test ! -e /tmp/oi-ephemeral && cd /workspace/oi-persistence && test -n "$(git diff -- tracked)"',
    ]);
    console.log(
      `Pause/resume cycle ${cycle + 1}: runtime ready, new runtime ID, uncommitted Git state retained, /tmp discarded`
    );
  }
  await provider.stopSandbox({
    providerObjectId: allocated,
    sessionId: "live-test",
    reason: "respawn",
  });
  console.log("Live lifecycle smoke passed (model execution and UI excluded)");
} finally {
  if (allocated) await provider.deleteSandbox(allocated);
}
