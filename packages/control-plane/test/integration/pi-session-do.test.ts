import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { collectMessages, initSession, openClientWs, queryDO } from "./helpers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Workspace } from "@cloudflare/computer";
import { componentsOf, runInSessionDO } from "./session-do-access";
import type { SourceControlProvider } from "../../src/source-control";
import type { PiHarnessWakeController } from "../../src/pi/pi-harness-wake";
import { PI_FEATURE_CAPABILITY_SNAPSHOT_KEY } from "../../src/pi/capability-snapshot";
import { WORKSPACE_QUOTA_STATE_KEY } from "../../src/pi/computer-workspace-quota";
import type { WorkspaceToolFacade } from "../../src/pi/computer-workspace-quota";
import { SessionInternalPaths } from "../../src/session/contracts";
import { createPiFeatureCapabilitySnapshot } from "@open-inspect/shared/pi-runtime-feature-capabilities";
import { createDurableObjectPiRuntimeDispatch } from "../../src/cloudflare/pi-runtime-dispatch";
import type {
  PiRuntimeControl,
  PiRuntimeControlResult,
  PiRuntimeDispatch,
} from "../../src/pi/runtime-contract";
import {
  PermanentPiResultDeliveryError,
  RetryablePiProjectionError,
} from "../../src/pi/projection-retry-policy";
import { PermanentRepositoryDiffPublicationError } from "../../src/pi/repository-diff-outbox";
import type { SessionDiffUpload } from "@open-inspect/shared/types/session-diffs";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createFauxCodexProvider } from "./faux-codex-provider";
import { PI_MODEL_PROVIDER_ID, piProviderFactories } from "../../src/pi/provider-factories";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { ProviderCredentialService } from "../../src/session/provider-credential-service";
import type { HarnessBudgetState } from "../../src/harness/budget-gate";

const defaultPiProviderFactory = piProviderFactories.factoryFor(PI_MODEL_PROVIDER_ID)!;
afterEach(() => piProviderFactories.register(PI_MODEL_PROVIDER_ID, defaultPiProviderFactory));

async function ensureActiveUser(userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, display_name, created_at, updated_at) VALUES (?, 'Pi User', ?, ?)"
    ).bind(userId, now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO user_role_assignments (user_id, role_id) SELECT ?, id FROM roles WHERE key = 'member'"
    ).bind(userId),
  ]);
}

function piStub(name: string): DurableObjectStub<PiSessionDO> {
  if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
  return env.PI_SESSION.getByName(name);
}
function controlPi(
  stub: DurableObjectStub<PiSessionDO>,
  input: PiRuntimeControl
): Promise<PiRuntimeControlResult> {
  return (
    stub as unknown as { control(value: PiRuntimeControl): Promise<PiRuntimeControlResult> }
  ).control(input);
}

function runInPiSessionDO<T>(
  stub: DurableObjectStub<PiSessionDO>,
  callback: (instance: PiSessionDO, state: DurableObjectState) => T | Promise<T>
): Promise<T> {
  return runInDurableObject(stub, (instance, state) => {
    if (!(instance instanceof PiSessionDO)) throw new Error("Expected PiSessionDO instance");
    return callback(instance, state);
  });
}

async function initializedPiStub(label: string) {
  const { sessionName } = await initSession({
    sessionName: `${label}-${crypto.randomUUID()}`,
    harness: "pi",
    model: "openai/gpt-5.6-sol",
    repoOwner: null,
    repoName: null,
    repoId: null,
  });
  return { sessionName, stub: piStub(sessionName) };
}

function workspaceOf(instance: PiSessionDO): WorkspaceToolFacade {
  const workspace = (instance as unknown as { workspace?: WorkspaceToolFacade }).workspace;
  if (!workspace) throw new Error("Expected initialized Computer Workspace");
  return workspace;
}

function rawWorkspaceOf(instance: PiSessionDO): Workspace {
  const workspace = (instance as unknown as { rawWorkspace?: Workspace }).rawWorkspace;
  if (!workspace) throw new Error("Expected initialized raw Computer Workspace");
  return workspace;
}

async function executeWorkspaceTool(
  instance: PiSessionDO,
  name: "read" | "ls" | "find" | "grep" | "write" | "edit" | "delete",
  args: Record<string, unknown>,
  callId: string
) {
  const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
  const tool = (await root.agent(BACKGROUND_CONTEXT)).tools.find(
    (candidate) => candidate.name === name
  );
  if (!tool) throw new Error(`Expected ${name} workspace tool`);
  return tool.execute(args, { callId } as ToolExecutionApi, BACKGROUND_CONTEXT);
}

async function executeAgentTool(
  instance: PiSessionDO,
  name: string,
  args: Record<string, JsonValue>,
  requestId: string
) {
  const models = (instance as unknown as { models: MutableModels }).models;
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
  await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
  // These focused adapter tests invoke Pi directly rather than through a
  // SessionDO processing message. Admit only the universal author gate here;
  // the end-to-end suite exercises that gate against the real current author.
  const piEnv = (instance as unknown as { env: { SESSION: typeof env.SESSION } }).env;
  const sessionNamespace = piEnv.SESSION;
  piEnv.SESSION = {
    getByName: (sessionId: string) => {
      const session = sessionNamespace.getByName(sessionId);
      return {
        fetch: (request: Request) =>
          new URL(request.url).pathname === SessionInternalPaths.harnessToolAuthorize
            ? Promise.resolve(new Response(null, { status: 204 }))
            : session.fetch(request),
      };
    },
  } as typeof env.SESSION;
  try {
    const submission = await root.submit(
      { type: "input", content: `call ${name}`, requestId },
      BACKGROUND_CONTEXT
    );
    await submission.wait(BACKGROUND_CONTEXT);
  } finally {
    piEnv.SESSION = sessionNamespace;
  }
  const view = await root.context(BACKGROUND_CONTEXT);
  const result = [...view.messages]
    .reverse()
    .find((message) => message.role === "toolResult" && message.toolName === name);
  if (!result || result.role !== "toolResult") throw new Error(`Missing ${name} tool result`);
  return result;
}

describe("PiSessionDO", () => {
  it("holds no deployment secret in its runtime bindings", async () => {
    const sessionName = `pi-binding-scope-${crypto.randomUUID()}`;
    const stub = piStub(sessionName);

    const names = await runInPiSessionDO(stub, (instance) => instance.runtimeBindingNames());

    // The object holds only the bindings it is allowed to hold. Remove the
    // scoping in the constructor and the whole Worker env is here instead —
    // every secret, the global database, every service binding — and this
    // assertion fails.
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(["SESSION", "CODEMODE_SANDBOX"]).toContain(name);
    }
    expect(names).toContain("SESSION");
    for (const secret of [
      "TOKEN_ENCRYPTION_KEY",
      "PROVIDER_ACCOUNTS_ENCRYPTION_KEY",
      "MCP_OAUTH_ENCRYPTION_KEY",
      "REPO_SECRETS_ENCRYPTION_KEY",
      "SERVICE_AUTH_SECRET_WEB",
      "SERVICE_AUTH_SECRET_SLACK_BOT",
      "GITHUB_APP_PRIVATE_KEY",
      "MODAL_TOKEN_SECRET",
      "SLACK_BOT_TOKEN",
      "DB",
      "BROWSER",
    ]) {
      expect(names).not.toContain(secret);
    }
  });

  it("fails the model budget gate closed without an attributable active operation", async () => {
    const { stub } = await initializedPiStub("pi-budget-authority");

    await runInPiSessionDO(stub, async (instance) => {
      const state = await (
        instance as unknown as { readBudgetState(): Promise<HarnessBudgetState> }
      ).readBudgetState();
      expect(state).toEqual({ exhausted: true, spentUsd: 0, capUsd: 0 });
    });
  });

  it("initializes idempotently only for the exact session identity and snapshot", async () => {
    const sessionName = `pi-initialize-${crypto.randomUUID()}`;
    const stub = piStub(sessionName);
    const snapshot = createPiFeatureCapabilitySnapshot({ scratchWorkspace: "enabled" });

    await expect(stub.initialize(sessionName, snapshot)).resolves.toBeUndefined();
    await expect(stub.initialize(sessionName, snapshot)).resolves.toBeUndefined();
    const mismatch = await runInPiSessionDO(stub, async (instance) => {
      try {
        await instance.initialize(
          sessionName,
          createPiFeatureCapabilitySnapshot({ scratchWorkspace: "off" })
        );
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(mismatch).toContain("capability snapshot mismatch");
    const identityMismatch = await runInPiSessionDO(stub, async (instance) => {
      try {
        await instance.initialize(`${sessionName}-other`, snapshot);
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(identityMismatch).toContain("session identity mismatch");
  });

  it("keeps an initialized capability snapshot across eviction", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-snapshot-eviction");
    await stub.status(sessionName);
    const before = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
    );
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: snapshot eviction"))
    ).rejects.toThrow();
    const restored = piStub(sessionName);
    await restored.status(sessionName);

    await expect(
      runInDurableObject(restored, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual(before);
  });

  it("persists the exact creation snapshot in SessionDO before the first Pi prompt", async () => {
    const { stub } = await initSession({
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });

    const rows = await queryDO<{ pi_feature_capability_snapshot: string }>(
      stub,
      "SELECT pi_feature_capability_snapshot FROM session"
    );
    expect(JSON.parse(rows[0]!.pi_feature_capability_snapshot)).toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        // Sandbox execution stays off until a provider passes the generation-78
        // isolation canary, so a creation snapshot never admits it.
        sandboxExecution: "off",
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
  });

  it("retries initialization after a lost response without re-resolving deployment flags", async () => {
    const { sessionName, stub } = await initSession({
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    await runInSessionDO(stub, (instance) => {
      const sessionEnv = (instance as unknown as { appEnv: Record<string, string> }).appEnv;
      sessionEnv.PI_WORKSPACE_MODE = "off";
      sessionEnv.PI_REPOSITORY_EDITING_MODE = "off";
    });

    const retry = await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName,
        repoOwner: null,
        repoName: null,
        userId: "user-1",
        harness: "pi",
        model: "openai/gpt-5.6-sol",
      }),
    });

    expect(retry.status).toBe(200);
    await expect(piStub(sessionName).status(sessionName)).resolves.toEqual({
      busy: false,
      pending: 0,
    });
    await expect(
      runInDurableObject(piStub(sessionName), (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toMatchObject({ capabilities: { scratchWorkspace: "enabled" } });
  });

  it("fails a creation retry closed when SessionDO's stored snapshot is malformed", async () => {
    const { sessionName, stub } = await initSession({
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    await queryDO(
      stub,
      "UPDATE session SET pi_feature_capability_snapshot = ?",
      JSON.stringify({ version: 999, capabilities: {} })
    );

    const outcome = await runInSessionDO(stub, async (instance) => {
      try {
        const response = await instance.fetch(
          new Request("http://internal/internal/init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionName,
              repoOwner: null,
              repoName: null,
              userId: "user-1",
              harness: "pi",
              model: "openai/gpt-5.6-sol",
            }),
          })
        );
        return `response:${response.status}`;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(outcome).toContain("Malformed persisted Pi capability snapshot");
  });

  it("installs the memory tools only when the capability admits them", async () => {
    const toolNames = async (mode: string) => {
      const { sessionName } = await initSession({
        harness: "pi",
        model: "openai/gpt-5.6-sol",
        repoOwner: null,
        repoName: null,
        repoId: null,
        configureSessionEnv: (sessionEnv) => {
          sessionEnv.PI_WORKSPACE_MODE = "off";
          sessionEnv.PI_REPOSITORY_EDITING_MODE = "off";
          sessionEnv.PI_CODE_MODE = "off";
          sessionEnv.PI_SANDBOX_EXECUTION_MODE = "off";
          sessionEnv.PI_MCP_MODE = "off";
          sessionEnv.PI_MEMORY_MODE = mode;
        },
      });
      await piStub(sessionName).status(sessionName);
      return runInPiSessionDO(piStub(sessionName), async (instance) => {
        const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
        return (await root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name);
      });
    };

    const enabled = await toolNames("enabled");
    const readOnly = await toolNames("read_only");
    const off = await toolNames("off");

    // A full capability admits the reads and the write; a read-only
    // capability admits the reads alone; an off capability admits nothing.
    expect(enabled.filter((name) => name.startsWith("memory_"))).toEqual([
      "memory_read",
      "memory_search",
      "memory_write",
    ]);
    expect(readOnly.filter((name) => name.startsWith("memory_"))).toEqual([
      "memory_read",
      "memory_search",
    ]);
    expect(off.filter((name) => name.startsWith("memory_"))).toEqual([]);
  });

  it("keeps an all-off creation snapshot after deployment flags enable before first prompt", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
      configureSessionEnv: (sessionEnv) => {
        sessionEnv.PI_WORKSPACE_MODE = "off";
        sessionEnv.PI_REPOSITORY_EDITING_MODE = "off";
        sessionEnv.PI_CODE_MODE = "off";
        sessionEnv.PI_SANDBOX_EXECUTION_MODE = "off";
        sessionEnv.PI_MCP_MODE = "off";
      },
    });
    await runInSessionDO(sessionStub, (instance) => {
      const sessionEnv = (instance as unknown as { appEnv: Record<string, string> }).appEnv;
      sessionEnv.PI_WORKSPACE_MODE = "writable";
      sessionEnv.PI_REPOSITORY_EDITING_MODE = "enabled";
      sessionEnv.PI_CODE_MODE = "enabled";
    });

    await piStub(sessionName).status(sessionName);
    const tools = await runInPiSessionDO(piStub(sessionName), async (instance) => {
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      return (await root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name);
    });
    expect(tools).toEqual(["subagent"]);
  });

  it("does not let an early blank open poison a committed creation snapshot", async () => {
    const sessionName = `pi-blank-race-${crypto.randomUUID()}`;
    if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
    const actualPi = createDurableObjectPiRuntimeDispatch(env.PI_SESSION);
    let initializeAvailable = false;
    const switchablePi: PiRuntimeDispatch = {
      ...actualPi,
      initialize: async (id, snapshot) => {
        if (!initializeAvailable) throw new Error("Pi initialize unavailable");
        await actualPi.initialize(id, snapshot);
      },
    };
    await expect(
      initSession({
        sessionName,
        harness: "pi",
        model: "openai/gpt-5.6-sol",
        repoOwner: null,
        repoName: null,
        repoId: null,
        configureSessionEnv: (sessionEnv) => {
          sessionEnv.PI_SESSION = switchablePi;
        },
      })
    ).rejects.toThrow("Init failed: 503");

    const earlyStub = piStub(sessionName);
    const [earlyStatus, earlySubmit] = await Promise.all([
      earlyStub.status(sessionName),
      earlyStub.submit({
        sessionId: sessionName,
        messageId: "early-submit",
        content: "do not run",
        model: "anthropic/not-supported-by-pi",
      }),
    ]);
    expect(earlyStatus).toEqual({ busy: false, pending: 0 });
    expect(earlySubmit).toMatchObject({ accepted: false });

    const sessionStub = env.SESSION.getByName(sessionName);
    initializeAvailable = true;
    const retry = await sessionStub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName,
        repoOwner: null,
        repoName: null,
        userId: "user-1",
        harness: "pi",
        model: "openai/gpt-5.6-sol",
      }),
    });
    expect(retry.status).toBe(200);

    const rows = await queryDO<{ pi_feature_capability_snapshot: string }>(
      sessionStub,
      "SELECT pi_feature_capability_snapshot FROM session"
    );
    const expected = JSON.parse(rows[0]!.pi_feature_capability_snapshot);
    await expect(
      runInDurableObject(piStub(sessionName), (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual(expected);
  });

  it("fails unopened legacy and malformed durable capability state closed", async () => {
    const legacy = await initializedPiStub("pi-legacy-unopened");
    const legacySessionStub = env.SESSION.getByName(legacy.sessionName);
    await queryDO(legacySessionStub, "UPDATE session SET pi_feature_capability_snapshot = NULL");
    await runInDurableObject(legacy.stub, async (_instance, state) => {
      await state.storage.deleteAll();
      await state.storage.put("open-inspect:session-id", legacy.sessionName);
    });

    await legacy.stub.status(legacy.sessionName);
    await expect(
      runInDurableObject(legacy.stub, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual(createPiFeatureCapabilitySnapshot({}));

    const malformedName = `pi-malformed-${crypto.randomUUID()}`;
    const malformed = piStub(malformedName);
    await runInDurableObject(malformed, async (_instance, state) => {
      await state.storage.put({
        "open-inspect:session-id": malformedName,
        [PI_FEATURE_CAPABILITY_SNAPSHOT_KEY]: { version: 999, capabilities: {} },
      });
    });
    const malformedResult = await runInPiSessionDO(malformed, async (instance) => {
      try {
        await instance.status(malformedName);
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(malformedResult).not.toBe("accepted");
  });

  it("survives a restart while a native control submission is in flight", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-control-restart");
    await stub.status(sessionName);

    // A follow-up starts its own run, so the submission is in flight when
    // the object is evicted. It was never admitted as a message of this
    // session, so it has no operation metadata.
    const accepted = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "control-restart-1",
      action: "follow_up",
      content: "keep going",
    });
    expect(accepted.state).toBe("accepted");

    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: control eviction"))
    ).rejects.toThrow();
    const restored = piStub(sessionName);

    // The restart must not fail: a control submission with no operation
    // metadata is not the event relay's business.
    await expect(restored.status(sessionName)).resolves.toMatchObject({ busy: true });
  });

  it("retains installed workspace tools but emergency-denies new mutations after Pi eviction", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-emergency-workspace-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    await runInPiSessionDO(stub, (instance) =>
      workspaceOf(instance).fs.writeFile("/workspace/scratch/readable.txt", "still readable")
    );
    await runInSessionDO(sessionStub, (instance) => {
      const sessionEnv = (instance as unknown as { appEnv: Record<string, string> }).appEnv;
      sessionEnv.PI_WORKSPACE_MODE = "off";
    });
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: emergency policy eviction"))
    ).rejects.toThrow();
    const restored = piStub(sessionName);
    await restored.status(sessionName);

    const results = await runInPiSessionDO(restored, async (instance) => ({
      write: await executeAgentTool(
        instance,
        "write",
        { path: "blocked.txt", content: "blocked" },
        "emergency-write"
      ),
      read: await executeAgentTool(instance, "read", { path: "readable.txt" }, "emergency-read"),
    }));
    expect(results.write.isError).toBe(true);
    expect(results.write.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("deployment policy") }),
      ])
    );
    expect(results.read.isError).not.toBe(true);
    expect(results.read.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("still readable") }),
      ])
    );
  });

  it("aborts a hung emergency-policy lookup so session destruction can finish", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-policy-abort");
    await stub.status(sessionName);

    const outcome = await runInPiSessionDO(stub, async (instance) => {
      let lookupStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        lookupStarted = resolve;
      });
      let releaseLookup: (() => void) | undefined;
      let lookupAborted = false;
      const fakeSessionNamespace = {
        getByName: () => ({
          fetch: (request: Request) =>
            new Promise<Response>((_resolve, reject) => {
              lookupStarted?.();
              releaseLookup = () => reject(new Error("test lookup released"));
              request.signal.addEventListener(
                "abort",
                () => {
                  lookupAborted = true;
                  reject(request.signal.reason);
                },
                { once: true }
              );
            }),
        }),
      };
      const piEnv = (instance as unknown as { env: { SESSION: unknown } }).env;
      const realSessionNamespace = piEnv.SESSION;
      piEnv.SESSION = fakeSessionNamespace;

      const models = (instance as unknown as { models: MutableModels }).models;
      const faux = fauxProvider();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", { path: "blocked.txt", content: "blocked" }), {
          stopReason: "toolUse",
        }),
      ]);
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
      await root.submit(
        { type: "input", content: "start mutation", requestId: "policy-abort" },
        BACKGROUND_CONTEXT
      );
      await started;
      piEnv.SESSION = realSessionNamespace;

      const destroying = instance.destroy(sessionName);
      const result = await Promise.race([
        destroying.then(() => "destroyed" as const),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 250)),
      ]);
      if (result === "timed_out") {
        releaseLookup?.();
        await destroying.catch(() => {});
      }
      return { result, lookupAborted };
    });

    expect(outcome).toEqual({ result: "destroyed", lookupAborted: true });
  });

  it("times out a hung emergency-policy lookup and denies the mutation", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-policy-timeout");
    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, async (instance) => {
      const piEnv = (instance as unknown as { env: { SESSION: unknown } }).env;
      const realSessionNamespace = piEnv.SESSION;
      piEnv.SESSION = {
        getByName: () => ({
          fetch: (request: Request) =>
            new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener("abort", () => reject(request.signal.reason), {
                once: true,
              });
            }),
        }),
      };
      try {
        return await executeAgentTool(
          instance,
          "write",
          { path: "blocked.txt", content: "blocked" },
          "policy-timeout"
        );
      } finally {
        piEnv.SESSION = realSessionNamespace;
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("timed out") }),
      ])
    );
  });

  it("creates a Pi SessionDO aggregate without any sandbox row", async () => {
    const { stub } = await initSession({
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });

    await expect(queryDO(stub, "SELECT id FROM sandbox")).resolves.toEqual([]);
  });

  it("preserves its durable record for an archive without deleting it", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-archive");
    await stub.status(sessionName);
    await queryDO(
      env.SESSION.getByName(sessionName),
      `INSERT INTO pi_operation_dispatch
         (operation_id, state, last_projection_sequence, created_at, updated_at)
       VALUES ('message-1', 'admitted', 0, 1, 1)`
    );
    await runInPiSessionDO(stub, async (instance) => {
      instance.projectionOutbox.enqueue(
        "message-1:token",
        "message-1",
        {
          type: "token",
          sandboxId: `pi:${sessionName}`,
          timestamp: 1,
          messageId: "message-1",
          content: "archived work",
          partId: "entry-1",
        },
        1
      );
    });

    await runInPiSessionDO(stub, (instance) => instance.preserveForArchive(sessionName));

    // The archive stops the agent and delivers what it produced, but it
    // deletes nothing: the conversation, the task graph and the workspace
    // files stay where they are.
    await runInPiSessionDO(stub, async (instance, state) => {
      expect(instance.projectionOutbox.undeliveredOperations()).toEqual([]);
      await expect(state.storage.get("open-inspect:session-id")).resolves.toBe(sessionName);
      await expect(state.storage.get("open-inspect:archive-state")).resolves.toBe("archived");
      await expect(
        instance.submit({
          sessionId: sessionName,
          messageId: "archived-message",
          content: "must not resume",
          model: "openai/gpt-5.6-sol",
        })
      ).resolves.toMatchObject({ accepted: false, rejected: "The session is archived" });
      await instance.restoreFromArchive(sessionName);
      await expect(state.storage.get("open-inspect:archive-state")).resolves.toBeUndefined();
    });
    const rows = await runInPiSessionDO(stub, async (_instance, state) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => (row as { name: string }).name)
    );
    expect(rows).toContain("oi_pi_projection_outbox");
    expect(rows).toContain("pi_conversations");
  });

  it("refuses to confirm an archive while a transcript event is undelivered", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-archive-incomplete");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, (instance) => {
      instance.projectionOutbox.enqueue(
        "missing-message:token",
        "missing-message",
        {
          type: "token",
          sandboxId: `pi:${sessionName}`,
          timestamp: 1,
          messageId: "missing-message",
          content: "must reach the transcript",
          partId: "entry-1",
        },
        1
      );
    });

    await expect(
      runInPiSessionDO(stub, (instance) => instance.preserveForArchive(sessionName))
    ).rejects.toThrow();
    await runInPiSessionDO(stub, async (instance, state) => {
      const failed = state.storage.sql
        .exec(
          "SELECT failed_at FROM oi_pi_projection_outbox WHERE operation_id = 'missing-message'"
        )
        .toArray();
      expect(failed).toHaveLength(1);
      await expect(state.storage.get("open-inspect:archive-state")).resolves.toBe("archiving");
      await expect(
        instance.submit({
          sessionId: sessionName,
          messageId: "cannot-race-archive",
          content: "must stay quiescent",
          model: "openai/gpt-5.6-sol",
        })
      ).resolves.toMatchObject({ accepted: false, rejected: "The session is archived" });
    });
  });

  it("exposes bounded native controls with sanitized inspection and exact cancellation", async () => {
    const faux = createFauxCodexProvider({
      models: [
        {
          id: "gpt-5.6-sol",
          name: "Faux gpt-5.6-sol",
          cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
        },
      ],
      responses: [
        {
          ...fauxAssistantMessage("controlled answer"),
          usage: {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, total: 1_998 },
          },
        },
      ],
    });
    piProviderFactories.register(PI_MODEL_PROVIDER_ID, () => faux.provider);
    const now = Date.now();
    const accountId = crypto.randomUUID().replaceAll("-", "");
    await env.DB.prepare(
      `INSERT INTO model_provider_accounts
         (id, provider, display_name, external_account_id, status, created_at, updated_at)
       VALUES (?, 'openai', 'OpenAI', 'acct-controls', 'active', ?, ?)`
    )
      .bind(accountId, now, now)
      .run();
    await new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!).create({
      providerAccountId: accountId,
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: {
        refreshToken: "openai-refresh-secret",
        accessToken: "openai-access-secret",
        accessTokenExpiresAt: now + 365 * 24 * 60 * 60 * 1_000,
      },
      accessTokenExpiresAt: now + 365 * 24 * 60 * 60 * 1_000,
      now,
    });
    await ensureActiveUser("user-1");
    const { sessionName } = await initSession({
      sessionName: `pi-controls-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
      providerAuth: [
        {
          provider: "openai",
          authMode: "provider_account",
          providerAccountId: accountId,
          selectionSource: "explicit",
        },
        { provider: "xai", authMode: "api_key", selectionSource: "explicit" },
        { provider: "anthropic", authMode: "api_key", selectionSource: "explicit" },
      ],
    });
    const stub = piStub(sessionName);
    const sessionStub = env.SESSION.getByName(sessionName);
    await expect(
      new ProviderCredentialService(
        env.DB,
        env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
      ).getProviderAccess(sessionName, "openai")
    ).resolves.toMatchObject({ credentialVersion: 1 });
    await stub.status(sessionName);
    await runInPiSessionDO(stub, async (instance) => {
      const installed = (instance as unknown as { models: MutableModels }).models.getProvider(
        PI_MODEL_PROVIDER_ID
      );
      expect(installed?.stream).not.toBe(faux.provider.stream);
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      await root.configure(
        { model: { provider: "openai-codex", modelId: "gpt-5.6-sol" } },
        BACKGROUND_CONTEXT
      );
    });
    const list = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "list-1",
      action: "list_conversations",
    });
    expect(list).toMatchObject({ state: "completed" });
    const submittedResponse = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.piControl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "user-1",
          canonicalUserId: "user-1",
          source: "web",
          control: {
            sessionId: sessionName,
            requestId: "control-submit-1",
            action: "send",
            content: "private sentinel prompt",
          },
        }),
      })
    );
    const submitted = await submittedResponse.json<PiRuntimeControlResult>();
    expect(submitted).toMatchObject({ state: "accepted" });
    await runInPiSessionDO(stub, async (instance) => {
      await expect(
        instance.control({
          sessionId: sessionName,
          requestId: "follow-config",
          action: "follow_up",
          content: "queued B",
          model: "openai/gpt-5.6-sol",
        })
      ).rejects.toThrow(/cannot start another turn/i);
    });
    const submissionId = (submitted.result as { submissionId: number }).submissionId;
    await runInPiSessionDO(stub, async (instance) => {
      const pi = await instance.harness.pi();
      const submission = await pi.submission(submissionId as never, BACKGROUND_CONTEXT);
      expect(submission).toBeDefined();
      const result = await submission!.wait(BACKGROUND_CONTEXT);
      expect(result).toMatchObject({ status: "done" });
    });
    await runInPiSessionDO(stub, async (instance) => {
      const totals = await (
        instance as unknown as {
          accountingTotals(): Promise<{
            usage: {
              input: number;
              output: number;
              cacheRead: number;
              cacheWrite: number;
              total: number;
            };
            costUsd: number;
          }>;
        }
      ).accountingTotals();
      expect(totals.usage.total).toBeGreaterThan(0);
      expect(totals.costUsd).toBeCloseTo(
        (totals.usage.input * 4 +
          totals.usage.output * 20 +
          totals.usage.cacheRead * 0.4 +
          totals.usage.cacheWrite * 5) /
          1_000_000,
        10
      );
    });
    const conversations = list.result as Array<{ id: number }>;
    const rootId = conversations[0]!.id;
    const detail = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "get-1",
      action: "get_conversation",
      conversationId: rootId,
    });
    const entries = (detail.result as { entries: Array<{ id: number }> }).entries;
    const fork = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "fork-1",
      action: "fork",
      conversationId: rootId,
      entryId: entries.at(-1)!.id,
    });
    expect(fork).toMatchObject({ state: "completed" });
    const forkId = (fork.result as { conversationId: number }).conversationId;
    await runInPiSessionDO(stub, async (instance) => {
      const forkConversation = await (
        await instance.harness.pi()
      ).conversation(forkId as never, BACKGROUND_CONTEXT);
      const extensionNames = (await forkConversation!.agent(BACKGROUND_CONTEXT)).extensions.map(
        (extension) => extension.name
      );
      expect(extensionNames).not.toContain("open-inspect.subagent");
      expect(extensionNames).not.toContain("open-inspect.agent-messaging");
    });
    await runInPiSessionDO(stub, async (instance) => {
      await expect(
        instance.control({
          sessionId: sessionName,
          requestId: "fork-depth",
          action: "fork",
          conversationId: forkId,
          entryId: entries.at(-1)!.id,
        })
      ).rejects.toThrow(/depth limit/i);
    });
    await expect(
      controlPi(stub, {
        sessionId: sessionName,
        requestId: "reset-1",
        action: "handoff",
        conversationId: rootId,
        handoff: "continue safely",
      })
    ).resolves.toMatchObject({ state: "completed" });
    const compact = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "compact-1",
      action: "compact",
      conversationId: rootId,
      instructions: "retain decisions",
    });
    expect(compact).toMatchObject({ state: "accepted" });
    const compactTaskId = (compact.result as { taskId: number }).taskId;
    await expect(
      controlPi(stub, {
        sessionId: sessionName,
        requestId: "cancel-compact",
        action: "cancel_exact",
        taskId: compactTaskId,
      })
    ).resolves.toMatchObject({ state: "completed" });
    const inspection = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "inspect-1",
      action: "inspect",
    });
    expect(JSON.stringify(inspection)).not.toContain("private sentinel prompt");
    expect(JSON.stringify(inspection)).not.toContain("open-inspect-control:");
    const agents = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "agents-1",
      action: "inspect_agents",
    });
    expect(agents).toMatchObject({
      state: "completed",
      result: {
        agents: expect.arrayContaining([expect.objectContaining({ conversationId: rootId })]),
      },
    });
    expect(JSON.stringify(agents)).not.toContain("private sentinel prompt");
    expect(JSON.stringify(agents)).not.toContain("controlled answer");
    expect(JSON.stringify(agents)).not.toContain("lastMessage");
    const lastMessage = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "last-message-1",
      action: "get_last_message",
      conversationId: rootId,
    });
    expect(lastMessage).toMatchObject({ result: { text: "controlled answer" } });
    const graph = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "graph-1",
      action: "task_graph",
    });
    expect(graph.state).toBe("completed");
    const cancel = await controlPi(stub, {
      sessionId: sessionName,
      requestId: "cancel-1",
      action: "cancel_exact",
      submissionId,
    });
    expect(cancel).toMatchObject({ state: "completed", result: { outcome: "settled" } });
  });

  it("replays one SessionDO control receipt after eviction", async () => {
    const { sessionName } = await initializedPiStub("pi-control-receipt");
    let sessionStub = env.SESSION.getByName(sessionName);
    const body = JSON.stringify({
      actorId: "user-1",
      source: "web",
      control: { sessionId: sessionName, requestId: "inspect-eviction", action: "inspect" },
    });
    const send = () =>
      sessionStub.fetch(
        new Request(`http://session${SessionInternalPaths.piControl}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      );
    expect((await send()).status).toBe(200);
    await expect(
      runInSessionDO(sessionStub, (_instance, state) =>
        state.abort("test: Pi control receipt eviction")
      )
    ).rejects.toThrow();
    sessionStub = env.SESSION.getByName(sessionName);
    await expect((await send()).json()).resolves.toMatchObject({
      requestId: "inspect-eviction",
      state: "completed",
    });
  });

  it("projects a human control once into SessionDO while keeping Pi assistant state subordinate", async () => {
    const faux = createFauxCodexProvider({
      models: [
        {
          id: "gpt-5.6-sol",
          name: "Faux gpt-5.6-sol",
          cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
        },
      ],
      responses: [
        {
          ...fauxAssistantMessage("native answer"),
          usage: {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, total: 1_998 },
          },
        },
      ],
    });
    piProviderFactories.register(PI_MODEL_PROVIDER_ID, () => faux.provider);
    const now = Date.now();
    const accountId = crypto.randomUUID().replaceAll("-", "");
    await env.DB.prepare(
      `INSERT INTO model_provider_accounts
         (id, provider, display_name, external_account_id, status, created_at, updated_at)
       VALUES (?, 'openai', 'OpenAI', 'acct', 'active', ?, ?)`
    )
      .bind(accountId, now, now)
      .run();
    await new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!).create({
      providerAccountId: accountId,
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: {
        refreshToken: "openai-refresh-secret",
        accessToken: "openai-access-secret",
        accessTokenExpiresAt: now + 365 * 24 * 60 * 60 * 1_000,
      },
      accessTokenExpiresAt: now + 365 * 24 * 60 * 60 * 1_000,
      now,
    });
    await ensureActiveUser("user-1");
    const { sessionName } = await initSession({
      sessionName: `pi-control-completion-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
      providerAuth: [
        {
          provider: "openai",
          authMode: "provider_account",
          providerAccountId: accountId,
          selectionSource: "explicit",
        },
        { provider: "xai", authMode: "api_key", selectionSource: "explicit" },
        { provider: "anthropic", authMode: "api_key", selectionSource: "explicit" },
      ],
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    await runInPiSessionDO(stub, async (instance) => {
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      await root.configure(
        { model: { provider: "openai-codex", modelId: "gpt-5.6-sol" } },
        BACKGROUND_CONTEXT
      );
    });
    const sessionStub = env.SESSION.getByName(sessionName);
    const response = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.piControl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "user-1",
          canonicalUserId: "user-1",
          source: "web",
          control: {
            sessionId: sessionName,
            requestId: "native-submit-1",
            action: "send",
            content: "native input",
          },
        }),
      })
    );
    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      await expect(
        queryDO(
          sessionStub,
          "SELECT state FROM pi_control_receipts WHERE request_id = ?",
          "native-submit-1"
        )
      ).resolves.toEqual([{ state: "completed" }]);
    });
    await expect(
      queryDO<{ id: string; author_id: string; content: string; status: string }>(
        sessionStub,
        "SELECT id, author_id, content, status FROM messages WHERE id = ?",
        "pi-control:native-submit-1"
      )
    ).resolves.toEqual([
      expect.objectContaining({
        id: "pi-control:native-submit-1",
        content: "native input",
        status: "completed",
      }),
    ]);
    const timelineEvents = await queryDO<{ data: string }>(
      sessionStub,
      "SELECT data FROM events WHERE id = ?",
      "user_message:pi-control:native-submit-1"
    );
    expect(timelineEvents).toHaveLength(1);
    expect(JSON.parse(timelineEvents[0]!.data)).toMatchObject({
      type: "user_message",
      content: "native input",
      piControl: { action: "send" },
    });
    expect(timelineEvents[0]!.data).not.toContain("native answer");
    expect(
      (
        await sessionStub.fetch(
          new Request(`http://session${SessionInternalPaths.piControl}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              actorId: "user-1",
              source: "web",
              control: {
                sessionId: sessionName,
                requestId: "native-submit-1",
                action: "send",
                content: "native input",
                model: "openai/gpt-5.6-sol",
              },
            }),
          })
        )
      ).status
    ).toBe(200);
    await expect(
      queryDO<{ count: number }>(
        sessionStub,
        "SELECT COUNT(*) AS count FROM events WHERE id = ?",
        "user_message:pi-control:native-submit-1"
      )
    ).resolves.toEqual([{ count: 1 }]);
    const [{ total_cost: totalCost }] = await queryDO<{ total_cost: number }>(
      sessionStub,
      "SELECT total_cost FROM session"
    );
    expect(totalCost).toBeGreaterThan(0);
  });

  it("broadcasts one attributed Pi control event to multiple existing session collaborators", async () => {
    const { sessionName } = await initializedPiStub("pi-control-multiplayer");
    const first = await openClientWs(sessionName, {
      subscribe: true,
      userId: "user-1",
      canonicalUserId: "user-1",
    });
    const second = await openClientWs(sessionName, {
      subscribe: true,
      userId: "user-2",
      canonicalUserId: "user-2",
    });
    const isControlEvent = (message: Record<string, unknown>) => {
      const event = message.event as Record<string, unknown> | undefined;
      return (
        message.type === "sandbox_event" &&
        event?.type === "user_message" &&
        event.messageId === "pi-control:multiplayer-reset"
      );
    };
    const firstEvents = collectMessages(first.ws, { until: isControlEvent });
    const secondEvents = collectMessages(second.ws, { until: isControlEvent });
    const sessionStub = env.SESSION.getByName(sessionName);
    const response = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.piControl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "service-user-3",
          canonicalUserId: "canonical-user-3",
          source: "web",
          control: {
            sessionId: sessionName,
            requestId: "multiplayer-reset",
            action: "reset",
          },
        }),
      })
    );
    expect(response.status).toBe(200);
    const [firstFrames, secondFrames] = await Promise.all([firstEvents, secondEvents]);
    for (const frames of [firstFrames, secondFrames]) {
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "sandbox_event",
          event: expect.objectContaining({
            type: "user_message",
            content: "Reset a Pi agent conversation.",
            author: expect.objectContaining({ userId: "canonical-user-3" }),
            piControl: { action: "reset" },
          }),
        })
      );
    }
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses follow-up controls while another turn is active", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-control-attribution");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, async (instance) => {
      const faux = fauxProvider({ tokensPerSecond: 1 });
      (instance as unknown as { models: MutableModels }).models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage("slow answer"),
        fauxAssistantMessage("follow-up answer"),
      ]);
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
    });
    await controlPi(stub, {
      sessionId: sessionName,
      requestId: "active-a",
      action: "submit",
      content: "A",
    });
    await runInPiSessionDO(stub, async (instance) => {
      await vi.waitFor(async () =>
        expect(
          (await (await instance.harness.pi()).inspect(BACKGROUND_CONTEXT)).submissions.some(
            (submission) =>
              submission.requestId?.endsWith("active-a") && submission.status === "placed"
          )
        ).toBe(true)
      );
    });
    await runInPiSessionDO(stub, async (instance) => {
      await expect(
        instance.control({
          sessionId: sessionName,
          requestId: "steer-b",
          action: "follow_up",
          content: "B",
        })
      ).rejects.toThrow("Busy Pi controls cannot start another turn");
      await expect(
        instance.control({
          sessionId: sessionName,
          requestId: "follow-c",
          action: "follow_up",
          content: "C",
        })
      ).rejects.toThrow("Busy Pi controls cannot start another turn");
    });
    await runInPiSessionDO(stub, async (instance) => {
      const submissions = (
        await (await instance.harness.pi()).inspect(BACKGROUND_CONTEXT)
      ).submissions.filter((submission) => submission.requestId?.endsWith("active-a"));
      expect(submissions).toHaveLength(1);
    });
    await controlPi(stub, {
      sessionId: sessionName,
      requestId: "cancel-a",
      action: "cancel_exact",
      operationId: "active-a",
    });
  });

  it("opens Pi without constructing Computer for an idle root conversation", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-idle");
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
    );
    expect(tables.some((name) => name.startsWith("pi_"))).toBe(true);
    expect(tables.some((name) => name.startsWith("vfs_") || name.startsWith("_vfs_"))).toBe(false);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        // Sandbox execution stays off until a provider passes the generation-78
        // isolation canary, so a creation snapshot never admits it.
        sandboxExecution: "off",
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
  });

  it("initializes idempotently for the same Open-Inspect session", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-repeat");
    await stub.status(sessionName);
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
  });

  it("reads durable scratch files through the confined Computer adapter", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-read");
    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, async (instance) => {
      const workspace = workspaceOf(instance);
      await workspace.fs.writeFile("/workspace/scratch/note.txt", "durable note");
      return executeWorkspaceTool(instance, "read", { path: "note.txt" }, "integration-read");
    });

    expect(result).toMatchObject({
      isError: false,
      output: [expect.objectContaining({ type: "text", text: "durable note" })],
    });
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
    await expect(
      runInPiSessionDO(stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/scratch/note.txt", "utf8")
      )
    ).resolves.toBe("durable note");
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.get(WORKSPACE_QUOTA_STATE_KEY))
    ).resolves.toMatchObject({ version: 2, bytes: 12, entries: 1, dirty: false });
  });

  it("writes, edits, and deletes scratch files through unsafe workspace tools", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-mutate");
    await stub.status(sessionName);

    const results = await runInPiSessionDO(stub, async (instance) => {
      const write = await executeWorkspaceTool(
        instance,
        "write",
        { path: "draft.txt", content: "hello world" },
        "integration-write"
      );
      const edit = await executeWorkspaceTool(
        instance,
        "edit",
        { path: "draft.txt", edits: [{ oldText: "world", newText: "Pi" }] },
        "integration-edit"
      );
      const text = await workspaceOf(instance).fs.readFile("/workspace/scratch/draft.txt", "utf8");
      const remove = await executeWorkspaceTool(
        instance,
        "delete",
        { path: "draft.txt" },
        "integration-delete"
      );
      return { write, edit, text, remove };
    });

    expect(results.write).toMatchObject({ isError: false });
    expect(results.edit).toMatchObject({ isError: false });
    expect(results.text).toBe("hello Pi");
    expect(results.remove).toMatchObject({ isError: false });
  });

  it("recovers dirty quota accounting after eviction and keeps the workspace root", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-recover");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, (instance) =>
      workspaceOf(instance).fs.writeFile("/workspace/scratch/kept.txt", "kept")
    );
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put(WORKSPACE_QUOTA_STATE_KEY, {
        bytes: 999_999,
        entries: 999,
        dirty: true,
      })
    );

    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: force Pi eviction"))
    ).rejects.toThrow();
    const restored = piStub(sessionName);
    await expect(restored.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });

    const rootDeletes = await runInPiSessionDO(restored, (instance) =>
      Promise.all(
        ["/workspace", "/workspace/scratch"].map((path, index) =>
          executeWorkspaceTool(
            instance,
            "delete",
            { path, recursive: true },
            `integration-delete-root-${index}`
          )
        )
      )
    );
    expect(rootDeletes).toEqual([
      expect.objectContaining({ isError: true }),
      expect.objectContaining({ isError: true }),
    ]);
    await expect(
      runInPiSessionDO(restored, (instance) =>
        workspaceOf(instance).fs.writeFile("/workspace/scratch/new.txt", "new")
      )
    ).resolves.toBeUndefined();
    await expect(
      runInDurableObject(restored, (_instance, state) =>
        state.storage.get(WORKSPACE_QUOTA_STATE_KEY)
      )
    ).resolves.toMatchObject({ version: 2, bytes: 7, entries: 2, dirty: false });
    await expect(
      runInPiSessionDO(restored, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/scratch/kept.txt", "utf8")
      )
    ).resolves.toBe("kept");
  });

  it("rejects workspace reads outside the configured root", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-root");
    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, async (instance) => {
      return executeWorkspaceTool(instance, "read", { path: "../outside.txt" }, "integration-root");
    });

    expect(result).toMatchObject({ isError: true });
  });

  it("rejects every workspace tool at a symlink escape", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-symlink");
    await stub.status(sessionName);

    const results = await runInPiSessionDO(stub, async (instance) => {
      await workspaceOf(instance).fs.stat("/workspace");
      const workspace = rawWorkspaceOf(instance);
      await workspace.fs.symlink("/outside-secret.txt", "/workspace/scratch/escape");
      return Promise.all([
        executeWorkspaceTool(instance, "read", { path: "escape" }, "symlink-read"),
        executeWorkspaceTool(instance, "ls", { path: "escape" }, "symlink-ls"),
        executeWorkspaceTool(instance, "find", { path: "escape", pattern: "**/*" }, "symlink-find"),
        executeWorkspaceTool(
          instance,
          "grep",
          { path: "escape", query: "visible" },
          "symlink-grep"
        ),
      ]);
    });

    expect(results).toHaveLength(4);
    expect(results.every((result) => result.isError === true)).toBe(true);
  });

  it("fails closed when the scratch root becomes a symlink before cold open", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-root-symlink");
    await stub.status(sessionName);
    await expect(
      runInPiSessionDO(stub, async (instance, state) => {
        await workspaceOf(instance).fs.stat("/workspace");
        const workspace = rawWorkspaceOf(instance);
        await workspace.fs.rm("/workspace/scratch", { recursive: true, force: true });
        await workspace.fs.symlink("/outside", "/workspace/scratch");
        state.abort("test: force Pi eviction after root replacement");
      })
    ).rejects.toThrow();

    await expect(piStub(sessionName).status(sessionName)).rejects.toThrow();
  });

  it("isolates identical workspace paths between Pi sessions", async () => {
    const first = await initializedPiStub("pi-workspace-isolation-a");
    const second = await initializedPiStub("pi-workspace-isolation-b");
    await Promise.all([
      first.stub.status(first.sessionName),
      second.stub.status(second.sessionName),
    ]);

    await Promise.all([
      runInPiSessionDO(first.stub, (instance) =>
        workspaceOf(instance).fs.writeFile("/workspace/scratch/same.txt", "first")
      ),
      runInPiSessionDO(second.stub, (instance) =>
        workspaceOf(instance).fs.writeFile("/workspace/scratch/same.txt", "second")
      ),
    ]);

    const [firstText, secondText] = await Promise.all([
      runInPiSessionDO(first.stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/scratch/same.txt", "utf8")
      ),
      runInPiSessionDO(second.stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/scratch/same.txt", "utf8")
      ),
    ]);
    expect(firstText).toBe("first");
    expect(secondText).toBe("second");
  });

  it("rejects diff refresh synchronously when repository editing is unavailable", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-diff-refresh-unavailable");

    await expect(
      runInPiSessionDO(stub, (instance) => instance.refreshDiff(sessionName))
    ).rejects.toThrow(/repository editing is not enabled/i);
  });

  it.each([
    { label: "network rejection", status: null, permanent: false },
    { label: "request timeout", status: 408, permanent: false },
    { label: "too early", status: 425, permanent: false },
    { label: "rate limiting", status: 429, permanent: false },
    { label: "server failure", status: 503, permanent: false },
    { label: "deterministic client rejection", status: 400, permanent: true },
  ])(
    "records $label in public diff state and classifies retryability",
    async ({ status, permanent }) => {
      const { stub } = await initializedPiStub("pi-diff-publication-failure");
      const bundle: SessionDiffUpload = {
        version: 1,
        triggerMessageId: null,
        capturedAt: 1,
        repositories: [
          {
            status: "ready",
            position: 0,
            repoOwner: "acme",
            repoName: "widgets",
            baseSha: "a".repeat(40),
            headSha: "a".repeat(40),
            truncated: false,
            omittedFileCount: 0,
            files: [],
          },
        ],
      };
      const failures: unknown[] = [];

      const error = await runInPiSessionDO(stub, async (instance) => {
        const target = instance as unknown as {
          env: {
            SESSION: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
          };
          publishDiffBundle(value: SessionDiffUpload): Promise<void>;
        };
        const real = target.env.SESSION;
        target.env.SESSION = {
          getByName: () => ({
            async fetch(request) {
              if (new URL(request.url).pathname === SessionInternalPaths.diffFailure) {
                failures.push(await request.json());
                return new Response(null, { status: 204 });
              }
              if (status === null) throw new Error("transport down");
              return new Response(null, { status });
            },
          }),
        };
        try {
          await target.publishDiffBundle(bundle);
          return null;
        } catch (caught) {
          return caught;
        } finally {
          target.env.SESSION = real;
        }
      });

      expect(failures).toHaveLength(0);
      expect(error instanceof PermanentRepositoryDiffPublicationError).toBe(permanent);
    }
  );

  it("hands a turn's image to the model as an image block", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-attachment-hydration");
    await stub.status(sessionName);
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const requested: Array<{ attachmentId: unknown; operationId: string | null }> = [];
    const realSessionNamespace = await runInPiSessionDO(stub, (instance) => {
      const faux = fauxProvider();
      (faux.provider as unknown as { id: string }).id = "openai-codex";
      (faux.provider.getModels()[0] as unknown as { provider: string }).provider = "openai-codex";
      (instance as unknown as { models: MutableModels }).models.setProvider(faux.provider);
      const piEnv = (instance as unknown as { env: { SESSION: unknown } }).env;
      const real = piEnv.SESSION;
      piEnv.SESSION = {
        getByName: () => ({
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            if (path === SessionInternalPaths.piCredential) {
              return Response.json({
                access_token: "fake-access-token",
                expires_in: 3_600,
                credential_version: 1,
              });
            }
            if (path === SessionInternalPaths.piAttachment) {
              const body = (await request.json()) as { attachmentId: string };
              requested.push({
                attachmentId: body.attachmentId,
                operationId: request.headers.get("X-Pi-Operation-ID"),
              });
              return new Response(imageBytes, { headers: { "Content-Type": "image/png" } });
            }
            return Response.json({ status: "projected" });
          },
        }),
      };
      return real;
    });

    try {
      await expect(
        stub.submit({
          sessionId: sessionName,
          messageId: "message-1",
          content: "describe this",
          model: "openai/faux-1",
          requirePricing: false,
          attachments: [{ name: "shot.png", attachmentId: "upload-1", mimeType: "image/png" }],
        })
      ).resolves.toMatchObject({ accepted: true });

      expect(requested).toEqual([{ attachmentId: "upload-1", operationId: "message-1" }]);
      const entries = await runInPiSessionDO(stub, (instance) =>
        instance.harness.messages({ session: "1" })
      );
      const userMessage = entries.find((entry) => entry.model?.[0]?.role === "user");
      expect(userMessage?.model?.[0]?.content).toEqual([
        { type: "text", text: "describe this" },
        {
          type: "image",
          data: Buffer.from(imageBytes).toString("base64"),
          mimeType: "image/png",
        },
      ]);
    } finally {
      await runInPiSessionDO(stub, (instance) => {
        (instance as unknown as { env: { SESSION: unknown } }).env.SESSION = realSessionNamespace;
      });
    }
  });

  it("refuses a turn whose image the session cannot serve", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-attachment-missing");
    await stub.status(sessionName);
    const realSessionNamespace = await runInPiSessionDO(stub, (instance) => {
      const faux = fauxProvider();
      (faux.provider as unknown as { id: string }).id = "openai-codex";
      (faux.provider.getModels()[0] as unknown as { provider: string }).provider = "openai-codex";
      (instance as unknown as { models: MutableModels }).models.setProvider(faux.provider);
      const piEnv = (instance as unknown as { env: { SESSION: unknown } }).env;
      const real = piEnv.SESSION;
      piEnv.SESSION = {
        getByName: () => ({
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            if (path === SessionInternalPaths.piCredential) {
              return Response.json({
                access_token: "fake-access-token",
                expires_in: 3_600,
                credential_version: 1,
              });
            }
            if (path === SessionInternalPaths.piAttachment) {
              return Response.json({ error: "Attachment not found" }, { status: 404 });
            }
            return Response.json({ status: "projected" });
          },
        }),
      };
      return real;
    });

    try {
      await expect(
        stub.submit({
          sessionId: sessionName,
          messageId: "message-1",
          content: "describe this",
          model: "openai/faux-1",
          requirePricing: false,
          attachments: [{ name: "shot.png", attachmentId: "upload-1", mimeType: "image/png" }],
        })
      ).resolves.toEqual({
        operationId: "message-1",
        accepted: false,
        rejected: "An attached image could not be loaded",
      });
    } finally {
      await runInPiSessionDO(stub, (instance) => {
        (instance as unknown as { env: { SESSION: unknown } }).env.SESSION = realSessionNamespace;
      });
    }
  });

  it("returns a definite rejection when initialization fails before Pi admission", async () => {
    const sessionId = `missing-${crypto.randomUUID()}`;
    const stub = piStub(sessionId);

    await expect(
      stub.submit({
        sessionId,
        messageId: "message-1",
        content: "hello",
        model: "openai/gpt-5.6-sol",
      })
    ).resolves.toEqual({
      operationId: "message-1",
      accepted: false,
      rejected: "Pi Durable initialization failed",
    });

    const jobTables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_jobs'"
        )
        .toArray()
    );
    expect(jobTables).toEqual([]);
    const vfsTables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'vfs_%' OR name LIKE '_vfs_%' OR name LIKE 'computer_%')"
        )
        .toArray()
    );
    expect(vfsTables).toEqual([]);
  });

  it("looks up and deduplicates an admitted operation through the real Pi store", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-operation-lookup");
    await stub.status(sessionName);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("durable answer")]);
    const realSessionNamespace = await runInPiSessionDO(stub, (instance) => {
      (faux.provider as unknown as { id: string }).id = "openai-codex";
      (faux.provider.getModels()[0] as unknown as { provider: string }).provider = "openai-codex";
      (instance as unknown as { models: MutableModels }).models.setProvider(faux.provider);
      const piEnv = (instance as unknown as { env: { SESSION: unknown } }).env;
      const real = piEnv.SESSION;
      piEnv.SESSION = {
        getByName: () => ({
          fetch: async (request: Request) =>
            new URL(request.url).pathname === SessionInternalPaths.piCredential
              ? Response.json({
                  access_token: "fake-access-token",
                  expires_in: 3_600,
                  credential_version: 1,
                })
              : Response.json({ status: "projected" }),
        }),
      };
      return real;
    });
    const prompt = {
      sessionId: sessionName,
      messageId: "message-deduplicated",
      content: "answer once",
      model: "openai/faux-1",
      requirePricing: false,
    };

    try {
      let frozenResult: Awaited<ReturnType<typeof stub.lookup>> | undefined;
      await expect(stub.lookup(sessionName, prompt.messageId)).resolves.toEqual({
        status: "not_found",
      });
      await expect(stub.submit(prompt)).resolves.toMatchObject({ accepted: true });
      await expect(stub.submit(prompt)).resolves.toMatchObject({ accepted: false });
      await vi.waitFor(async () => {
        const lookup = await stub.lookup(sessionName, prompt.messageId);
        frozenResult = lookup;
        expect(lookup).toMatchObject({
          status: "settled",
          result: {
            operationId: prompt.messageId,
            status: "unanswered",
            reason: "model_error",
            costUsd: 0,
          },
        });
      });
      const piStored = await runInDurableObject(stub, (_instance, state) => {
        const tables = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
          )
          .toArray();
        return tables.flatMap(({ name }) =>
          state.storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray()
        );
      });
      expect(JSON.stringify(piStored)).not.toContain("fake-access-token");
      const before = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ cost_usd: number; captured_at: number }>(
            `SELECT cost_usd, captured_at FROM oi_pi_projection_finalization
             WHERE operation_id = ?`,
            prompt.messageId
          )
          .toArray()
      );
      await runInPiSessionDO(stub, async (instance) => {
        const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
        const newer = await root.submit(
          {
            type: "write",
            requestId: "newer-display-entry",
            entry: {
              kind: "test.newer-user",
              model: [{ role: "user", content: "newer turn", timestamp: Date.now() }],
            },
          },
          BACKGROUND_CONTEXT
        );
        await newer.wait(BACKGROUND_CONTEXT);
        (
          instance as unknown as {
            accountingTotals(): Promise<{
              usage: {
                input: number;
                output: number;
                cacheRead: number;
                cacheWrite: number;
                total: number;
              };
              costUsd: number;
            }>;
          }
        ).accountingTotals = async () => ({
          usage: { input: 999_999, output: 999, cacheRead: 0, cacheWrite: 0, total: 1_000_998 },
          costUsd: 999,
        });
      });

      const retry = await stub.lookup(sessionName, prompt.messageId);
      expect(retry).toEqual(frozenResult);

      await expect(
        runInDurableObject(stub, (_instance, state) =>
          state.storage.sql
            .exec<{ cost_usd: number; captured_at: number }>(
              `SELECT cost_usd, captured_at FROM oi_pi_projection_finalization
               WHERE operation_id = ?`,
              prompt.messageId
            )
            .toArray()
        )
      ).resolves.toEqual(before);
      await runInPiSessionDO(stub, async (instance, state) => {
        state.storage.sql.exec(
          `UPDATE cf_agents_jobs SET time = 0
           WHERE capability = 'pi-projection' AND id = ?`,
          prompt.messageId
        );
        await (instance as unknown as { alarm(): Promise<void> }).alarm();
      });
      await expect(
        runInDurableObject(stub, (_instance, state) =>
          state.storage.get<{ projectedCostUsd: number }>(
            `open-inspect:operation:${prompt.messageId}`
          )
        )
      ).resolves.toMatchObject({ projectedCostUsd: 0 });
    } finally {
      await runInPiSessionDO(stub, (instance) => {
        (instance as unknown as { env: { SESSION: unknown } }).env.SESSION = realSessionNamespace;
      });
    }
  });

  it("fails closed before model admission when a cost-capped model is unpriced", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-unpriced-cap");
    await stub.status(sessionName);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("must not run")]);
    await runInPiSessionDO(stub, (instance) => {
      (faux.provider as unknown as { id: string }).id = "openai-codex";
      (faux.provider.getModels()[0] as unknown as { provider: string }).provider = "openai-codex";
      (instance as unknown as { models: MutableModels }).models.setProvider(faux.provider);
    });

    await expect(
      stub.submit({
        sessionId: sessionName,
        messageId: "message-unpriced",
        content: "do not admit",
        model: "openai/faux-1",
        requirePricing: true,
      })
    ).resolves.toMatchObject({ accepted: false });
    expect(faux.state.callCount).toBe(0);
    await expect(stub.lookup(sessionName, "message-unpriced")).resolves.toEqual({
      status: "not_found",
    });
  });

  it("installs repository and subagent extensions for a repository-backed session", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "develop",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "src/app.ts",
              type: "file",
              blobId: "blob-app",
              mode: "100644",
              sizeBytes: 18,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob: async () => new TextEncoder().encode("export const x=1;\n"),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    const refreshJobCount = await runInPiSessionDO(stub, async (instance, state) => {
      await instance.refreshDiff(sessionName);
      await instance.refreshDiff(sessionName);
      const rows = [
        ...state.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM cf_agents_jobs WHERE id = ?",
          "repository-diff-publication"
        ),
      ] as Array<{ count: number }>;
      return rows[0]?.count ?? 0;
    });
    expect(refreshJobCount).toBe(1);

    const agent = await runInPiSessionDO(stub, async (instance) => {
      const pi = await instance.harness.pi();
      const root = await pi.root(BACKGROUND_CONTEXT);
      const selected = await root.agent(BACKGROUND_CONTEXT);
      return {
        tools: selected.tools.map((tool) => tool.name),
        extensions: selected.extensions.map(({ name }) => name),
      };
    });
    expect(agent.tools).toEqual([
      "repository_list",
      "repository_read",
      "subagent",
      "read",
      "ls",
      "find",
      "grep",
      "write",
      "edit",
      "delete",
    ]);
    expect(agent.extensions).toEqual([
      "open-inspect.tool-policy",
      "open-inspect",
      "open-inspect.subagent",
      "open-inspect.workspace",
      "open-inspect.repository-overlay",
    ]);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        // Sandbox execution stays off until a provider passes the generation-78
        // isolation canary, so a creation snapshot never admits it.
        sandboxExecution: "off",
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("open-inspect:repository-pins")
      )
    ).resolves.toEqual([
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        commitSha: "a".repeat(40),
      },
    ]);
  });

  it("publishes guarded repository mutations through the SessionDiff service", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-edit-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "src/app.ts",
              type: "file",
              blobId: "blob-app",
              mode: "100644",
              sizeBytes: 18,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob: async () => new TextEncoder().encode("export const x=1;\n"),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, (instance) =>
      executeWorkspaceTool(
        instance,
        "write",
        { path: "/workspace/repos/0/src/app.ts", content: "export const x=2;\n" },
        "integration-write"
      )
    );

    expect(result).toMatchObject({ isError: false });
    await vi.waitFor(async () => {
      const rows = await queryDO<{ bundle_json: string }>(
        sessionStub,
        "SELECT bundle_json FROM session_diff WHERE singleton = 1"
      );
      expect(JSON.parse(rows[0]?.bundle_json ?? "null")).toMatchObject({
        repositories: [
          {
            baseSha: "a".repeat(40),
            files: [expect.objectContaining({ path: "src/app.ts", status: "modified" })],
          },
        ],
      });
    });

    const retry = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.diffRetry}`, { method: "POST" })
    );
    expect(retry.status).toBe(202);
  });

  it("emergency-denies repository mutations after eviction while repository reads still work", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-emergency-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "src/app.ts",
              type: "file",
              blobId: "blob-app",
              mode: "100644",
              sizeBytes: 18,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob: async () => new TextEncoder().encode("export const x=1;\n"),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    await runInSessionDO(sessionStub, (instance) => {
      const sessionEnv = (instance as unknown as { appEnv: Record<string, string> }).appEnv;
      sessionEnv.PI_REPOSITORY_EDITING_MODE = "off";
    });
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: repository policy eviction"))
    ).rejects.toThrow();
    const restored = piStub(sessionName);
    await restored.status(sessionName);

    const results = await runInPiSessionDO(restored, async (instance) => ({
      write: await executeAgentTool(
        instance,
        "write",
        { path: "/workspace/repos/0/src/app.ts", content: "export const x=2;\n" },
        "emergency-repository-write"
      ),
      read: await executeAgentTool(
        instance,
        "read",
        { path: "/workspace/repos/0/src/app.ts" },
        "emergency-repository-read"
      ),
    }));
    expect(results.write.isError).toBe(true);
    expect(results.write.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("deployment policy") }),
      ])
    );
    expect(results.read.isError).not.toBe(true);
    expect(results.read.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("x=1") })])
    );
  });

  it("deletes an evicted repository workspace without rematerializing provider data", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-delete-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({ entries: [], truncated: false }),
        readBlob: async () => new Uint8Array(),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: evict repository Pi"))
    ).rejects.toThrow();
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => {
          throw new Error("repository access revoked");
        },
        listTree: async () => {
          throw new Error("repository access revoked");
        },
        readBlob: async () => {
          throw new Error("repository access revoked");
        },
      } as unknown as SourceControlProvider;
    });

    await expect(piStub(sessionName).destroy(sessionName)).resolves.toBeUndefined();
  });

  it("restores a complete repository workspace after eviction without provider access", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-restore-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    const readBlob = vi.fn(async () => new TextEncoder().encode("durable\n"));
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "durable.txt",
              type: "file",
              blobId: "89d6550e43ce52434725cfb864c6feed1b3632d5",
              mode: "100644",
              sizeBytes: 8,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob,
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    expect(readBlob).not.toHaveBeenCalled();
    await runInPiSessionDO(stub, (instance) =>
      executeWorkspaceTool(
        instance,
        "read",
        { path: "/workspace/repos/0/durable.txt" },
        "read-initialize-overlay"
      )
    );
    expect(readBlob).toHaveBeenCalledOnce();
    await runInPiSessionDO(stub, async (instance) => {
      const workspace = rawWorkspaceOf(instance);
      const path = "/.open-inspect/repositories/0/manifest.json";
      const manifest = JSON.parse(await workspace.fs.readFile(path, "utf8")) as {
        files: Array<Record<string, unknown>>;
      };
      await workspace.fs.writeFile(
        path,
        JSON.stringify({
          ...manifest,
          version: 1,
          files: manifest.files.map(({ contentSha256: _hash, ...file }) => file),
        })
      );
    });
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: evict repository Pi"))
    ).rejects.toThrow();
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => {
          throw new Error("repository access revoked");
        },
        listTree: async () => {
          throw new Error("repository access revoked");
        },
        readBlob: async () => {
          throw new Error("repository access revoked");
        },
      } as unknown as SourceControlProvider;
    });

    await expect(piStub(sessionName).status(sessionName)).resolves.toMatchObject({ busy: false });
    const result = await runInPiSessionDO(piStub(sessionName), (instance) =>
      executeWorkspaceTool(
        instance,
        "read",
        { path: "/workspace/repos/0/durable.txt" },
        "read-restored"
      )
    );
    expect(result).toMatchObject({ isError: false });
    await expect(
      runInPiSessionDO(piStub(sessionName), (instance) =>
        rawWorkspaceOf(instance).fs.readFile("/.open-inspect/repositories/0/manifest.json", "utf8")
      )
    ).resolves.toContain('"version":2');
  });

  it("rejects invalid UTF-8 provider bytes before mutating the real Computer VFS", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-binary-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "invalid.bin",
              type: "file",
              blobId: "blob-invalid",
              mode: "100644",
              sizeBytes: 1,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob: async () => new Uint8Array([0xff]),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);

    await expect(
      runInPiSessionDO(stub, (instance) =>
        executeWorkspaceTool(
          instance,
          "write",
          { path: "/workspace/repos/0/invalid.bin", content: "replacement\n" },
          "integration-invalid-utf8"
        )
      )
    ).rejects.toThrow("UTF-8 text");
    const bytes = await runInPiSessionDO(stub, async (instance) => {
      const stream = await workspaceOf(instance).fs.readFile("/workspace/repos/0/invalid.bin");
      const reader = stream.getReader();
      const chunk = await reader.read();
      return chunk.value;
    });
    expect(bytes).toEqual(new Uint8Array([0xff]));
  });

  it("materializes 51 provider files through bounded SessionDO batches", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-batches-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    const readBlob = vi.fn(async () => new TextEncoder().encode("x"));
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: Array.from({ length: 51 }, (_, index) => ({
            path: `file-${index}.txt`,
            type: "file",
            blobId: `blob-${index}`,
            mode: "100644",
            sizeBytes: 1,
            executable: false,
          })),
          truncated: false,
        }),
        readBlob,
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);

    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, (instance) =>
      executeWorkspaceTool(instance, "read", { path: "/workspace/repos/0/file-50.txt" }, "read-51")
    );
    expect(result).toMatchObject({ isError: false });
    expect(readBlob).toHaveBeenCalledTimes(51);
  });

  it("recovers a claimed baseline when Pi crashes before persisting its pins", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-pin-crash-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    const firstSha = "a".repeat(40);
    const movedSha = "b".repeat(40);
    const resolveCommit = vi.fn(async () => ({ sha: firstSha }));
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit,
        listTree: async () => ({ entries: [], truncated: false }),
        readBlob: async () => new Uint8Array(),
      } as unknown as SourceControlProvider;
    });
    const claimed = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.piContext}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "pin" }),
      })
    );
    expect(claimed.status).toBe(200);
    resolveCommit.mockResolvedValue({ sha: movedSha });

    const stub = piStub(sessionName);
    await stub.status(sessionName);
    await runInPiSessionDO(stub, (instance) =>
      executeAgentTool(instance, "repository_list", {}, "lazy-pin-read")
    );

    expect(resolveCommit).toHaveBeenCalledOnce();
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("open-inspect:repository-pins")
      )
    ).resolves.toEqual([
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        commitSha: firstSha,
      },
    ]);
  });

  it("clears Pi transcript and lifecycle storage when the session is deleted", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-delete");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, (instance) =>
      workspaceOf(instance).fs.writeFile("/workspace/scratch/delete-me.txt", "gone")
    );

    await stub.destroy(sessionName);
    await stub.destroy(sessionName);

    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
        )
        .toArray()
        .map((row) => row.name)
    );
    expect(tables.some((name) => name.startsWith("pi_"))).toBe(false);
    expect(tables.some((name) => name.startsWith("oi_pi_"))).toBe(false);
    expect(
      tables.some(
        (name) =>
          name.startsWith("vfs_") || name.startsWith("_vfs_") || name.startsWith("computer_")
      )
    ).toBe(false);
  });

  it("deletes a cold Pi object before its harness has opened", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-delete-cold");

    await expect(stub.destroy(sessionName)).resolves.toBeUndefined();

    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
        )
        .toArray()
        .map((row) => row.name)
    );
    expect(tables.some((name) => name.startsWith("pi_"))).toBe(false);
    expect(tables.some((name) => name.startsWith("oi_pi_"))).toBe(false);
    expect(
      tables.some(
        (name) =>
          name.startsWith("vfs_") || name.startsWith("_vfs_") || name.startsWith("computer_")
      )
    ).toBe(false);
  });

  it("keeps one projection job when the same operation is scheduled again", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-projection");
    await stub.status(sessionName);

    await runInPiSessionDO(stub, async (instance) => {
      await instance.projector.schedule({
        sessionId: sessionName,
        operationId: "message-1",
      });
      await instance.projector.schedule({
        sessionId: sessionName,
        operationId: "message-1",
      });
    });

    const jobs = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM cf_agents_jobs WHERE capability = 'pi-projection' AND id = 'message-1'"
        )
        .toArray()
    );
    expect(JSON.parse(jobs[0]?.payload ?? "null")).toMatchObject({
      sessionId: sessionName,
      operationId: "message-1",
    });
  });

  it("classifies terminal result 409 as permanent and 500 as retryable", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-result-delivery-classification");
    await stub.status(sessionName);

    const outcomes = await runInPiSessionDO(stub, async (instance) => {
      const piEnv = (instance as unknown as { env: { SESSION: unknown } }).env;
      const original = piEnv.SESSION;
      const statuses = [409, 500];
      let attempts = 0;
      piEnv.SESSION = {
        getByName: () => ({
          fetch: async () => new Response(null, { status: statuses[attempts++]! }),
        }),
      };
      const deliver = (
        instance as unknown as {
          deliverResult(
            targetSessionId: string,
            result: {
              operationId: string;
              status: "done";
              text: string;
              costUsd: number;
            }
          ): Promise<void>;
        }
      ).deliverResult.bind(instance);
      try {
        const errors: unknown[] = [];
        for (const operationId of ["permanent", "retryable"]) {
          try {
            await deliver(sessionName, { operationId, status: "done", text: "", costUsd: 0 });
          } catch (error) {
            errors.push(error);
          }
        }
        return { attempts, errors };
      } finally {
        piEnv.SESSION = original;
      }
    });

    expect(outcomes.attempts).toBe(2);
    expect(outcomes.errors[0]).toBeInstanceOf(PermanentPiResultDeliveryError);
    expect(outcomes.errors[1]).toBeInstanceOf(RetryablePiProjectionError);
  });

  it("retries terminal rejection cleanup without redelivering the rejected result", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-result-rejection-cleanup");
    await stub.status(sessionName);
    const operationId = "cleanup-after-409";

    const outcome = await runInPiSessionDO(stub, async (instance, state) => {
      await state.storage.put(`open-inspect:operation:${operationId}`, {
        model: "openai/gpt-5.6-sol",
        baseline: {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          costUsd: 0,
        },
        projectedCostUsd: 0,
      });
      instance.projectionOutbox.markFinalized(
        operationId,
        {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          costUsd: 0,
        },
        1
      );
      await instance.projector.schedule({ sessionId: sessionName, operationId });
      state.storage.sql.exec(
        `UPDATE cf_agents_jobs
         SET time = 0, payload = json_set(payload, '$.admissionDeadline', 0)
         WHERE capability = 'pi-projection' AND id = ?`,
        operationId
      );
      const internals = instance as unknown as {
        deliverResult(): Promise<void>;
        settleOperationMetadata(targetOperationId: string): Promise<void>;
        alarm(): Promise<void>;
      };
      let deliveries = 0;
      internals.deliverResult = async () => {
        deliveries += 1;
        throw new PermanentPiResultDeliveryError("Pi result delivery rejected (409)");
      };
      const settle = internals.settleOperationMetadata.bind(instance);
      let cleanups = 0;
      internals.settleOperationMetadata = async (targetOperationId) => {
        cleanups += 1;
        if (cleanups === 1) throw new Error("transient cleanup failure");
        await settle(targetOperationId);
      };

      await internals.alarm();
      const afterFirst = state.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM cf_agents_jobs
           WHERE capability = 'pi-projection' AND id = ?`,
          operationId
        )
        .toArray();
      state.storage.sql.exec(
        `UPDATE cf_agents_jobs SET time = 0
         WHERE capability = 'pi-projection' AND id = ?`,
        operationId
      );
      await internals.alarm();
      const afterSecond = state.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM cf_agents_jobs
           WHERE capability = 'pi-projection' AND id = ?`,
          operationId
        )
        .toArray();
      return {
        deliveries,
        cleanups,
        afterFirst,
        afterSecond,
        metadata: await state.storage.get<{ settledAt?: number }>(
          `open-inspect:operation:${operationId}`
        ),
      };
    });

    expect(outcome.deliveries).toBe(1);
    expect(outcome.cleanups).toBe(2);
    // Lifecycle may consume its configured retry inside the same alarm turn.
    expect(outcome.afterFirst).toEqual([]);
    expect(outcome.afterSecond).toEqual([]);
    expect(outcome.metadata?.settledAt).toEqual(expect.any(Number));
  });

  it("resumes the Pi harness after object eviction so pending work continues", async () => {
    const { sessionName } = await initSession({
      sessionName: `pi-hibernation-resume-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: hibernation"))
    ).rejects.toThrow();

    // A reopened object must schedule the Pi work that survived the eviction,
    // which is what the upstream onWake contract does for a serverless host.
    const restored = piStub(sessionName);
    await runInPiSessionDO(restored, async (instance) => {
      await instance.harness.pi();
      const controller = (instance as unknown as { wakeController?: PiHarnessWakeController })
        .wakeController;
      expect(controller).toBeDefined();
      expect(controller?.resumes).toBeGreaterThan(0);
      expect(controller?.nativeWakeSupported).toBe(false);
      await expect(controller?.wake()).resolves.toMatchObject({ active: expect.any(Boolean) });
    });
  });

  it("drains an undelivered Pi projection through Lifecycle after object eviction", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-projection-outbox-eviction-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    await queryDO(
      sessionStub,
      `INSERT INTO pi_operation_dispatch
       (operation_id, state, last_projection_sequence, created_at, updated_at)
       VALUES ('message-1', 'admitted', 0, 1, 1)`
    );
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    await runInPiSessionDO(stub, async (instance, state) => {
      await state.storage.put("open-inspect:operation:message-1", {
        model: "openai/gpt-5.6-sol",
        baseline: {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          costUsd: 0,
        },
        projectedCostUsd: 0,
      });
      instance.projectionOutbox.enqueue(
        "message-1:token",
        "message-1",
        {
          type: "token",
          sandboxId: `pi:${sessionName}`,
          timestamp: 1,
          messageId: "message-1",
          content: "final",
          partId: "entry-1",
        },
        1
      );
      await instance.projector.schedule({
        sessionId: sessionName,
        operationId: "message-1",
      });
      state.storage.sql.exec(
        `UPDATE cf_agents_jobs
         SET time = 0, payload = json_set(payload, '$.admissionDeadline', 0)
         WHERE capability = 'pi-projection' AND id = 'message-1'`
      );
    });
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: projection eviction"))
    ).rejects.toThrow();

    const restored = piStub(sessionName);
    await runInPiSessionDO(restored, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    await expect(
      runInPiSessionDO(restored, (instance) => instance.projectionOutbox.pending("message-1"))
    ).resolves.toBe(0);
    await expect(
      queryDO<{ last_projection_sequence: number }>(
        sessionStub,
        `SELECT last_projection_sequence FROM pi_operation_dispatch
         WHERE operation_id = 'message-1'`
      )
    ).resolves.toEqual([{ last_projection_sequence: 2 }]);
    await expect(
      runInDurableObject(restored, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT id FROM cf_agents_jobs
             WHERE capability = 'pi-projection' AND id = 'message-1'`
          )
          .toArray()
      )
    ).resolves.toEqual([]);
  });

  it("persists the authoritative operation cost high-water across relay eviction", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-cost-high-water");
    await stub.status(sessionName);
    const key = "open-inspect:operation:message-cost";
    const observed = await runInPiSessionDO(stub, async (instance, state) => {
      await state.storage.put(key, {
        model: "openai/gpt-5.6-sol",
        baseline: {
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 },
          costUsd: 1,
        },
        projectedCostUsd: 0.5,
      });
      const internals = instance as unknown as {
        accountingTotals(): Promise<{
          usage: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
          };
          costUsd: number;
        }>;
        checkpointAccounting(operationId: string): Promise<void>;
      };
      internals.accountingTotals = async () => ({
        usage: { input: 110, output: 11, cacheRead: 0, cacheWrite: 0, total: 121 },
        costUsd: 3.5,
      });
      await internals.checkpointAccounting("message-cost");
      return state.storage.get<{ projectedCostUsd: number }>(key);
    });
    expect(observed?.projectedCostUsd).toBe(2.5);
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: cost relay eviction"))
    ).rejects.toThrow();

    await expect(
      runInDurableObject(piStub(sessionName), (_instance, state) =>
        state.storage.get<{ projectedCostUsd: number }>(key)
      )
    ).resolves.toMatchObject({ projectedCostUsd: 2.5 });
  });

  it("drops a stale pending checkpoint when A finalizes while global B accounting is read", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-stale-accounting-checkpoint");
    await stub.status(sessionName);
    const key = "open-inspect:operation:message-a";
    let releaseAccounting!: (value: {
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
      costUsd: number;
    }) => void;
    const accounting = new Promise<{
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
      costUsd: number;
    }>((resolve) => {
      releaseAccounting = resolve;
    });
    let accountingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      accountingStarted = resolve;
    });

    let checkpoint!: Promise<void>;
    await runInPiSessionDO(stub, async (instance, state) => {
      await state.storage.put(key, {
        model: "openai/gpt-5.6-sol",
        baseline: {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          costUsd: 0,
        },
        projectedCostUsd: 0,
      });
      const internals = instance as unknown as {
        accountingTotals(): Promise<{
          usage: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
          };
          costUsd: number;
        }>;
        checkpointAccounting(operationId: string): Promise<void>;
      };
      internals.accountingTotals = async () => {
        accountingStarted();
        return accounting;
      };
      checkpoint = internals.checkpointAccounting("message-a");
    });
    await started;
    await runInPiSessionDO(stub, (instance) => {
      instance.projectionOutbox.markFinalized(
        "message-a",
        {
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          costUsd: 0.01,
        },
        1
      );
    });
    releaseAccounting({
      usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, total: 1_100 },
      costUsd: 10,
    });
    await checkpoint;

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<{ projectedCostUsd: number }>(key)
      )
    ).resolves.toMatchObject({ projectedCostUsd: 0 });
    await expect(
      runInPiSessionDO(stub, (instance) => instance.projectionOutbox.pending("message-a"))
    ).resolves.toBe(0);
  });

  it("keeps the relay open when the projector runs before slow durable admission", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-slow-admission");
    await stub.status(sessionName);
    const operationId = "slow-admission-operation";
    const result = await runInPiSessionDO(stub, async (instance, state) => {
      let releaseAdmission!: () => void;
      const admissionReleased = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      let admissionStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        admissionStarted = resolve;
      });
      const harness = instance.harness as unknown as {
        submit: PiSessionDO["harness"]["submit"];
      };
      const submit = harness.submit.bind(instance.harness);
      harness.submit = async (...args) => {
        admissionStarted();
        await admissionReleased;
        return submit(...args);
      };
      const submission = instance.submit({
        sessionId: sessionName,
        messageId: operationId,
        content: "admit after projector alarm",
        model: "openai/gpt-5.6-sol",
        requirePricing: false,
      });
      await started;
      state.storage.sql.exec(
        `UPDATE cf_agents_jobs SET time = 0
         WHERE capability = 'pi-projection' AND id = ?`,
        operationId
      );
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
      const finalizedBeforeAdmission = instance.projectionOutbox.isFinalized(operationId);

      releaseAdmission();
      const receipt = await submission;
      await instance.harness.wait(operationId, { session: "1" });
      const lookup = await instance.lookup(sessionName, operationId);
      return {
        finalizedBeforeAdmission,
        receipt,
        lookup,
        finalAccounting: instance.projectionOutbox.finalAccounting(operationId),
      };
    });

    expect(result.finalizedBeforeAdmission).toBe(false);
    expect(result.receipt).toMatchObject({ accepted: true, operationId });
    expect(result.lookup).toMatchObject({ status: "settled" });
    expect(result.finalAccounting).not.toBeNull();
  });

  it("bounds settled Pi operation accounting metadata", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-metadata-retention");
    await stub.status(sessionName);

    const retained = await runInPiSessionDO(stub, async (instance, state) => {
      for (let index = 0; index < 130; index++) {
        await state.storage.put(`open-inspect:operation:retained-${index}`, {
          model: "openai/gpt-5.6-sol",
          baseline: {
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            costUsd: 0,
          },
          projectedCostUsd: 0,
          settledAt: index,
        });
      }
      await (
        instance as unknown as { settleOperationMetadata(operationId: string): Promise<void> }
      ).settleOperationMetadata("retained-129");
      return state.storage.list({ prefix: "open-inspect:operation:" });
    });

    expect(retained.size).toBe(128);
    expect(retained.has("open-inspect:operation:retained-0")).toBe(false);
    expect(retained.has("open-inspect:operation:retained-129")).toBe(true);
  });

  it("permanently disables lifecycle alarms before deleting the Pi object", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-delete-alarm");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, async (instance) => {
      await instance.projector.schedule({
        sessionId: sessionName,
        operationId: "message-1",
      });
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    ).resolves.not.toBeNull();

    await stub.destroy(sessionName);

    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    ).resolves.toBeNull();
  });
});
