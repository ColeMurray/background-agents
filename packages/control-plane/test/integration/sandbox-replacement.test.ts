import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, runDurableObjectAlarm } from "cloudflare:test";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { COMPATIBLE_RUNTIME_VERSION } from "../../src/image-builds/test-helpers";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/sandbox/lifecycle/manager";
import type { SandboxProvider } from "../../src/sandbox/provider";
import { SANDBOX_REPLACED_ERROR } from "../../src/session/interruption-messages";
import { cleanD1Tables } from "./cleanup";
import {
  closeWebSocket,
  collectMessages,
  initNamedSession,
  openSandboxWs,
  queryDO,
  seedActiveUser,
  seedMessage,
  seedSandboxAuth,
} from "./helpers";
import { fetchRuns, makeRunRow, seedRun } from "./run-helpers";
import { componentsOf, runInSessionDO } from "./session-do-access";

const OLD_TOKEN = "replaced-sandbox-token";
const OLD_SANDBOX_ID = "sb-replaced";
const OLD_OBJECT_ID = "sb-replaced-object";
const AUTOMATION_ID = "auto-replacement";
const RUN_ID = "run-replacement";

beforeEach(cleanD1Tables);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanD1Tables();
});

interface Launch {
  sandboxId: string;
  authToken: string;
}

/**
 * A session whose sandbox ran "msg-running" and has "msg-queued" waiting
 * behind it. The sandbox's generation is older than the respawn cooldown.
 */
async function seedInterruptedTurn(
  name: string,
  sandbox: { status: string; heartbeatAgeMs: number; managed?: boolean }
) {
  const { stub } = await initNamedSession(name);
  await seedSandboxAuth(stub, { authToken: OLD_TOKEN, sandboxId: OLD_SANDBOX_ID });
  const now = Date.now();
  const createdAt = now - 60_000;
  await runInSessionDO(stub, (_instance: SessionDO, state) => {
    state.storage.sql.exec(
      `UPDATE sandbox SET status = ?, created_at = ?, modal_object_id = ?, runtime_version = ?,
         last_heartbeat = ?, last_activity = ?`,
      sandbox.status,
      createdAt,
      OLD_OBJECT_ID,
      COMPATIBLE_RUNTIME_VERSION,
      now - sandbox.heartbeatAgeMs,
      now
    );
    if (sandbox.managed) {
      state.storage.sql.exec(
        "INSERT INTO sandbox_preservation (singleton, state) VALUES (1, ?)",
        JSON.stringify({
          phase: "running",
          generation: { sandboxId: OLD_SANDBOX_ID, createdAt },
          providerObjectId: OLD_OBJECT_ID,
          lifetimeKind: "finite",
          expiresAtMs: now + 30 * 60_000,
          drainAtMs: now + 20 * 60_000,
          generationReady: true,
          runtimeReady: true,
          protocolVersion: 1,
          lifecyclePolicy: "confirmed",
        })
      );
    }
  });
  const [owner] = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants WHERE user_id = 'user-1'"
  );
  await seedMessage(stub, {
    id: "msg-running",
    authorId: owner.id,
    content: "Refactor the parser",
    source: "slack",
    status: "processing",
    createdAt: now - 30_000,
    startedAt: now - 20_000,
  });
  await seedMessage(stub, {
    id: "msg-queued",
    authorId: owner.id,
    content: "Then add tests",
    source: "slack",
    status: "pending",
    createdAt: now - 10_000,
  });
  return stub;
}

/** Makes "msg-running" the prompt of a running automation run, unattended by anyone. */
async function seedAutomationRun(stub: DurableObjectStub, sessionName: string) {
  const owner = "automation-owner";
  const now = Date.now();
  await seedActiveUser(owner);
  await env.DB.prepare(
    `INSERT INTO automations
       (id, owner_team_id, name, instructions, trigger_type, model, created_by, user_id,
        created_at, updated_at, trigger_config)
     VALUES (?, NULL, 'Nightly refactor', 'Fixture only', 'webhook', 'anthropic/claude-sonnet-4-6',
       ?, ?, ?, ?, ?)`
  )
    .bind(AUTOMATION_ID, owner, owner, now, now, JSON.stringify({ conditions: [] }))
    .run();
  await seedRun(
    makeRunRow(AUTOMATION_ID, {
      id: RUN_ID,
      session_id: sessionName,
      status: "running",
      started_at: now,
    })
  );
  await runInSessionDO(stub, (_instance: SessionDO, state) => {
    state.storage.sql.exec(
      "UPDATE messages SET source = 'automation', callback_context = ? WHERE id = 'msg-running'",
      JSON.stringify({
        source: "automation",
        automationId: AUTOMATION_ID,
        runId: RUN_ID,
        automationName: "Nightly refactor",
      })
    );
  });
}

/** Stubs provider launches on the live DO, capturing the replacement's credentials. */
function stubProviderLaunches(provider: SandboxProvider) {
  const launches: Launch[] = [];
  const lifetime = () => ({ kind: "none" as const, observedAtMs: Date.now() });
  vi.spyOn(provider, "createSandbox").mockImplementation(async (config) => {
    launches.push({ sandboxId: config.sandboxId, authToken: config.sandboxAuthToken });
    return {
      sandboxId: config.sandboxId,
      providerObjectId: "replacement-object",
      createdAt: Date.now(),
      lifetime: lifetime(),
    };
  });
  vi.spyOn(provider, "restoreFromSnapshot").mockImplementation(async (config) => {
    launches.push({ sandboxId: config.sandboxId, authToken: config.sandboxAuthToken });
    return {
      success: true as const,
      sandboxId: config.sandboxId,
      providerObjectId: "replacement-object",
      lifetime: lifetime(),
    };
  });
  return launches;
}

async function messageStates(stub: DurableObjectStub) {
  return queryDO<{ id: string; status: string; error_message: string | null }>(
    stub,
    "SELECT id, status, error_message FROM messages ORDER BY created_at"
  );
}

/** Boots the replacement's bridge through readiness and returns the first prompt it receives. */
async function connectReplacement(name: string, launch: Launch) {
  const { ws, response } = await openSandboxWs(name, launch);
  expect(response.status).toBe(101);
  ws!.accept();
  ws!.addEventListener("message", (event) => {
    const command = JSON.parse(String(event.data)) as { type: string; generation?: unknown };
    if (command.type !== "sandbox_generation") return;
    ws!.send(
      JSON.stringify({
        type: "sandbox_generation_ready",
        generation: command.generation,
        sandboxId: launch.sandboxId,
        timestamp: Date.now() / 1000,
      })
    );
  });
  const delivered = collectMessages(ws!, {
    until: (message) => message.type === "prompt",
    timeoutMs: 5_000,
  });
  ws!.send(
    JSON.stringify({
      type: "ready",
      sandboxId: launch.sandboxId,
      timestamp: Date.now() / 1000,
      preservationProtocolVersion: 1,
    })
  );
  const prompt = (await delivered).find((message) => message.type === "prompt");
  return { ws: ws!, prompt };
}

describe("a sandbox replaced while a prompt is processing", () => {
  it("fails the prompt when a restore replaces the sandbox during the heartbeat watchdog's stop, then runs the queued prompt", async () => {
    const { timeoutMs, reconnectGraceMs } = DEFAULT_LIFECYCLE_CONFIG.heartbeat;
    const name = `replacement-restore-${Date.now()}`;
    const stub = await seedInterruptedTurn(name, {
      status: "ready",
      heartbeatAgeMs: timeoutMs + reconnectGraceMs + 1_000,
      managed: true,
    });
    await seedAutomationRun(stub, name);
    let releaseWatchdogStop!: () => void;
    const { launches, stopSandbox } = await runInSessionDO(
      stub,
      async (instance: SessionDO, state) => {
        const provider = componentsOf(instance).sandboxProvider;
        vi.spyOn(provider, "takeSnapshot").mockResolvedValue({
          success: true,
          imageId: "heartbeat-image",
        });
        const watchdogStop = new Promise<void>((resolve) => (releaseWatchdogStop = resolve));
        const stopSandbox = vi.spyOn(provider, "stopSandbox").mockImplementation(async (config) => {
          if (config.reason === "heartbeat_timeout") await watchdogStop;
          return { success: true };
        });
        await state.storage.setAlarm(Date.now() + 60_000);
        return { launches: stubProviderLaunches(provider), stopSandbox };
      }
    );

    // The watchdog marks the sandbox stale, saves it, and awaits its stop.
    const alarm = runDurableObjectAlarm(stub);
    await vi.waitFor(() =>
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "heartbeat_timeout" })
      )
    );
    // A launch admitted meanwhile restores the save as a new instance.
    await runInSessionDO(stub, (instance: SessionDO) =>
      componentsOf(instance).lifecycleManager.spawnSandbox()
    );
    expect(launches).toHaveLength(1);
    await runInSessionDO(stub, () => releaseWatchdogStop());
    await expect(alarm).resolves.toBe(true);

    // The watchdog yields to the replacement, which settles the orphaned prompt
    // and tells its integration, as an execution timeout would.
    expect(await messageStates(stub)).toEqual([
      { id: "msg-running", status: "failed", error_message: SANDBOX_REPLACED_ERROR },
      { id: "msg-queued", status: "pending", error_message: null },
    ]);
    await vi.waitFor(
      async () =>
        expect(await fetchRuns(AUTOMATION_ID)).toEqual([
          expect.objectContaining({
            id: RUN_ID,
            status: "failed",
            failure_reason: SANDBOX_REPLACED_ERROR,
          }),
        ]),
      { timeout: 5_000 }
    );

    const { ws, prompt } = await connectReplacement(name, launches[0]);
    try {
      expect(prompt).toEqual(expect.objectContaining({ messageId: "msg-queued" }));
    } finally {
      await closeWebSocket(ws);
    }
  });

  it("fails the prompt when a fresh spawn replaces a stale sandbox", async () => {
    const name = `replacement-spawn-${Date.now()}`;
    const stub = await seedInterruptedTurn(name, { status: "stale", heartbeatAgeMs: 120_000 });
    const launches = await runInSessionDO(stub, async (instance: SessionDO) => {
      const { sandboxProvider, lifecycleManager } = componentsOf(instance);
      vi.spyOn(sandboxProvider, "stopSandbox").mockResolvedValue({ success: true });
      const launches = stubProviderLaunches(sandboxProvider);
      await lifecycleManager.spawnSandbox();
      return launches;
    });

    expect(launches).toHaveLength(1);
    expect(launches[0].sandboxId).not.toBe(OLD_SANDBOX_ID);
    expect(await messageStates(stub)).toEqual([
      { id: "msg-running", status: "failed", error_message: SANDBOX_REPLACED_ERROR },
      { id: "msg-queued", status: "pending", error_message: null },
    ]);

    const { ws, prompt } = await connectReplacement(name, launches[0]);
    try {
      expect(prompt).toEqual(expect.objectContaining({ messageId: "msg-queued" }));
    } finally {
      await closeWebSocket(ws);
    }
  });

  it("leaves the processing prompt to the bridge an in-place resume keeps", async () => {
    const name = `replacement-resume-${Date.now()}`;
    const stub = await seedInterruptedTurn(name, { status: "stopped", heartbeatAgeMs: 120_000 });
    const resumed = await runInSessionDO(stub, async (instance: SessionDO) => {
      const { sandboxProvider, lifecycleManager } = componentsOf(instance);
      Object.assign(sandboxProvider.capabilities, { supportsPersistentResume: true });
      const resumeSandbox = vi.fn(async () => ({
        success: true as const,
        lifetime: { kind: "none" as const, observedAtMs: Date.now() },
      }));
      sandboxProvider.resumeSandbox = resumeSandbox;
      const launches = stubProviderLaunches(sandboxProvider);
      await lifecycleManager.spawnSandbox();
      return { calls: resumeSandbox.mock.calls.length, launches };
    });

    expect(resumed).toEqual({ calls: 1, launches: [] });
    expect(await queryDO(stub, "SELECT modal_sandbox_id, status FROM sandbox")).toEqual([
      { modal_sandbox_id: OLD_SANDBOX_ID, status: "connecting" },
    ]);
    expect(await messageStates(stub)).toEqual([
      { id: "msg-running", status: "processing", error_message: null },
      { id: "msg-queued", status: "pending", error_message: null },
    ]);
  });
});
