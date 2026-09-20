import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { SessionIndexStore } from "../../src/db/session-index";
import { initializeSession } from "../../src/session/initialize";
import {
  readSandboxExecutionSettings,
  resolveSandboxLaunchSpec,
} from "../../src/sandbox/execution";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { createRequestMetrics } from "../../src/db/instrumented-sql-database";
import { cleanD1Tables } from "./cleanup";
import { queryDO, serviceFetch, serviceRequestHeaders, sqlDatabase } from "./helpers";

describe("session execution admission", () => {
  beforeEach(cleanD1Tables);

  async function configureDocker(cpuCores = 3, memoryMib = 6144): Promise<void> {
    const response = await serviceFetch("https://test.local/integration-settings/sandbox", {
      method: "PUT",
      body: JSON.stringify({
        settings: { defaults: { dockerEnabled: true, cpuCores, memoryMib } },
      }),
    });
    expect(response.status).toBe(200);
  }

  async function createDockerSession(enabled: boolean): Promise<Response> {
    const url = "https://test.local/sessions";
    const body = JSON.stringify({ title: "Docker integration", dockerEnabled: true });
    const request = new Request(url, {
      method: "POST",
      headers: await serviceRequestHeaders(url, {
        method: "POST",
        body,
        service: "slack-bot",
        actor: "slack:U0123",
      }),
      body,
    });
    return worker.fetch(
      request,
      { ...env, ENABLE_MODAL_VM_SANDBOXES: enabled ? "true" : "false" } as WorkerBindings,
      createExecutionContext()
    );
  }

  it("rejects Docker while the gate is closed without creating a D1 session", async () => {
    await configureDocker();

    const response = await createDockerSession(false);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "docker_not_available" });
    const rows = await env.DB.prepare("SELECT id FROM sessions").all();
    expect(rows.results).toHaveLength(0);
  });

  it("rejects malformed persisted execution intent without creating a session", async () => {
    await configureDocker();
    await env.DB.prepare(
      "UPDATE integration_settings SET settings = ? WHERE integration_id = 'sandbox'"
    )
      .bind(JSON.stringify({ defaults: { dockerEnabled: "true" }, enabledRepos: null }))
      .run();

    const response = await createDockerSession(true);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "invalid_sandbox_execution" });
    const rows = await env.DB.prepare("SELECT id FROM sessions").all();
    expect(rows.results).toHaveLength(0);
  });

  it("persists one admitted Docker execution contract without the legacy boolean", async () => {
    await configureDocker(3, 6144);

    const response = await createDockerSession(true);

    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    expect(await new SessionIndexStore(env.DB).get(sessionId)).not.toBeNull();
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const [session] = await queryDO<{
      sandbox_settings: string;
      sandbox_execution: string;
    }>(stub, "SELECT sandbox_settings, sandbox_execution FROM session");
    expect(JSON.parse(session.sandbox_settings)).toEqual({ cpuCores: 3, memoryMib: 6144 });
    expect(JSON.parse(session.sandbox_execution)).toEqual({
      profile: "docker-v1",
      provider: "modal",
      cpuCores: 3,
      memoryMib: 6144,
    });
  });

  it("initializes from the admitted snapshot even when live settings change afterward", async () => {
    await configureDocker(3, 6144);
    const platformEnv = createCloudflareEnv({
      ...env,
      ENABLE_MODAL_VM_SANDBOXES: "true",
    } as WorkerBindings);
    const snapshot = await readSandboxExecutionSettings(sqlDatabase(env.DB), null);
    const sandboxLaunchSpec = resolveSandboxLaunchSpec(platformEnv, snapshot);
    await configureDocker(8, 12_288);
    const sessionId = `snapshot-${crypto.randomUUID()}`;

    await initializeSession(
      platformEnv,
      {
        sessionId,
        repoOwner: null,
        repoName: null,
        repoId: null,
        harness: "opencode",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        participantUserId: "slack:U0123",
        platformUserId: null,
        sandboxLaunchSpec,
        managedSkillsManifest: {
          selection: { mode: "all" },
          resolverVersion: 1,
          manifestSha256: "0".repeat(64),
          resolvedAt: 1,
          skills: [],
        },
        providerAuth: [
          { provider: "openai", authMode: "api_key", selectionSource: "fallback_api_key" },
          { provider: "xai", authMode: "api_key", selectionSource: "fallback_api_key" },
          { provider: "anthropic", authMode: "api_key", selectionSource: "api_key_fallback" },
        ],
      },
      {
        db: sqlDatabase(env.DB),
        trace_id: "snapshot-test",
        request_id: crypto.randomUUID(),
        metrics: createRequestMetrics(),
        executionCtx: { submit() {} },
      }
    );

    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const [session] = await queryDO<{
      sandbox_settings: string;
      sandbox_execution: string;
    }>(stub, "SELECT sandbox_settings, sandbox_execution FROM session");
    expect(JSON.parse(session.sandbox_settings)).toEqual({ cpuCores: 3, memoryMib: 6144 });
    expect(JSON.parse(session.sandbox_execution)).toMatchObject({
      profile: "docker-v1",
      cpuCores: 3,
      memoryMib: 6144,
    });
  });
});
