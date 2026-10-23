import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { PI_FEATURE_CAPABILITY_SNAPSHOT_KEY } from "../../src/pi/capability-snapshot";
import { initSession, queryDO } from "../integration/helpers";
import { runInSessionDO } from "../integration/session-do-access";
import { defineExtension, defineTool, type Registry } from "@earendil-works/pi-durable";
import type { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { Workspace } from "@cloudflare/computer";

interface PiSessionInternals {
  registry: Registry;
  models: MutableModels;
  codemodeSandbox?: RemoteCodemodeSandbox;
  workspace?: Workspace;
}

async function recordLiveTurn(sessionName: string, operationId: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, display_name, created_at, updated_at) VALUES ('user-1', 'Code Mode User', ?, ?)"
    ).bind(now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO user_role_assignments (user_id, role_id) SELECT 'user-1', id FROM roles WHERE key = 'member'"
    ),
  ]);
  await runInSessionDO(env.SESSION.getByName(sessionName), (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR IGNORE INTO participants (id, user_id, canonical_user_id, role, joined_at) VALUES ('user-1', 'user-1', 'user-1', 'member', ?)",
      now
    );
    state.storage.sql.exec(
      "INSERT INTO messages (id, author_id, content, source, status, created_at) VALUES (?, 'user-1', 'code mode', 'web', 'processing', ?)",
      operationId,
      now
    );
  });
}

describe("PiSessionDO native Code Mode", () => {
  it("keeps Code Mode installed but denies a fresh call when deployment policy flips off", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-codemode-emergency-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    await recordLiveTurn(sessionName, "codemode-emergency");
    await runInSessionDO(sessionStub, (instance) => {
      (instance as unknown as { appEnv: { PI_CODE_MODE?: string } }).appEnv.PI_CODE_MODE = "off";
    });
    if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
    const stub = env.PI_SESSION.getByName(sessionName);
    await stub.status(sessionName);

    const result = await runInDurableObject(stub, async (instance) => {
      if (!(instance instanceof PiSessionDO)) throw new Error("Expected PiSessionDO instance");
      const internals = instance as unknown as PiSessionInternals;
      const faux = fauxProvider();
      internals.models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code: "return 1;" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      const selected = await root.agent(BACKGROUND_CONTEXT);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
      const submission = await root.submit(
        { type: "input", content: "run new code", requestId: "codemode-emergency" },
        BACKGROUND_CONTEXT
      );
      await submission.wait(BACKGROUND_CONTEXT);
      const view = await root.context(BACKGROUND_CONTEXT);
      const toolResult = [...view.messages]
        .reverse()
        .find((message) => message.role === "toolResult" && message.toolName === "codemode");
      return {
        installed: selected.tools.some(({ name }) => name === "codemode"),
        text:
          toolResult?.role === "toolResult"
            ? toolResult.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n")
            : "",
      };
    });

    expect(result.installed).toBe(true);
    expect(result.text).toContain("disabled for new calls by deployment policy");
  });

  it("latches the paid capability and exposes only read-only tools to scripts", async () => {
    const { sessionName } = await initSession({
      sessionName: `pi-codemode-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
    const stub = env.PI_SESSION.getByName(sessionName);

    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });

    const agent = await runInDurableObject(stub, async (instance) => {
      if (!(instance instanceof PiSessionDO)) throw new Error("Expected PiSessionDO instance");
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      const resolved = await root.agent(BACKGROUND_CONTEXT);
      return {
        modelTools: resolved.tools.map((tool) => tool.name),
        callableTools: resolved.callable.map((tool) => tool.name),
      };
    });

    expect(agent.modelTools).toEqual(["subagent", "read", "ls", "find", "grep", "codemode"]);
    expect(agent.callableTools).toEqual(["read", "ls", "find", "grep"]);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "read_only",
        repositoryEditing: "off",
        codeMode: "enabled",
        sandboxExecution: "off",
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
  });

  it("backfills legacy Pi state without silently adding Code Mode", async () => {
    const { sessionName } = await initSession({
      sessionName: `pi-codemode-legacy-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
    const stub = env.PI_SESSION.getByName(sessionName);
    await queryDO(
      env.SESSION.getByName(sessionName),
      "UPDATE session SET pi_feature_capability_snapshot = NULL"
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      await state.storage.put("open-inspect:session-id", sessionName);
    });

    await stub.status(sessionName);

    const tools = await runInDurableObject(stub, async (instance) => {
      if (!(instance instanceof PiSessionDO)) throw new Error("Expected PiSessionDO instance");
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      return (await root.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    });
    expect(tools).not.toContain("codemode");
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "off",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
  });

  it("resumes PiHarness through the remote DO and reattaches an authorized read", async () => {
    const { sessionName } = await initSession({
      sessionName: `pi-codemode-restart-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
    const stub = env.PI_SESSION.getByName(sessionName);
    await recordLiveTurn(sessionName, "remote-restart");
    let interruptedReadStarted: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      interruptedReadStarted = resolve;
    });

    await runInDurableObject(stub, async (instance, state) => {
      if (!(instance instanceof PiSessionDO)) throw new Error("Expected PiSessionDO instance");
      const internals = instance as unknown as PiSessionInternals;
      await instance.status(sessionName);
      await internals.workspace?.fs.writeFile(
        "/workspace/scratch/restart.txt",
        "durable remote read"
      );
      const interruptedRead = defineTool({
        name: "read",
        description: "Read workspace files",
        parameters: Type.Object({ path: Type.String() }),
        replay: "safe",
        async execute(_args, _api, context) {
          interruptedReadStarted?.();
          return new Promise((_resolve, reject) => {
            context.abortSignal?.addEventListener(
              "abort",
              () => reject(context.abortSignal?.reason),
              { once: true }
            );
          });
        },
      });
      internals.registry.install(
        defineExtension({ name: "test.interrupted-read", tools: [interruptedRead] })
      );
      const faux = fauxProvider();
      internals.models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: 'return await tools.read({ path: "restart.txt" });',
          }),
          { stopReason: "toolUse" }
        ),
      ]);
      const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
      await state.storage.put("open-inspect:operation:remote-restart", {
        model: "openai/gpt-5.6-sol",
        baseline: {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          costUsd: 0,
        },
        projectedCostUsd: 0,
      });
      await root.submit(
        { type: "input", content: "read after restart", requestId: "remote-restart" },
        BACKGROUND_CONTEXT
      );
      await waiting;
      await internals.codemodeSandbox?.close();
    });

    await abortAllDurableObjects();
    const restartedStub = env.PI_SESSION.getByName(sessionName);
    await restartedStub.status(sessionName);

    let codemodeResult = "";
    for (let attempt = 0; attempt < 50 && codemodeResult === ""; attempt++) {
      codemodeResult = await runInDurableObject(restartedStub, async (instance) => {
        if (!(instance instanceof PiSessionDO)) throw new Error("Expected PiSessionDO instance");
        const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
        const view = await root.context(BACKGROUND_CONTEXT);
        const result = view.messages.find(
          (message) => message.role === "toolResult" && message.toolName === "codemode"
        );
        if (!result || result.role !== "toolResult") return "";
        return result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
      });
      if (codemodeResult === "") await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(codemodeResult).toContain("durable remote read");
  }, 20_000);

  it.each([
    { label: "active", interruptBeforeDestroy: false },
    { label: "interrupted", interruptBeforeDestroy: true },
  ])(
    "destroys a Pi session with an $label Code Mode script",
    async ({ interruptBeforeDestroy }) => {
      const { sessionName } = await initSession({
        sessionName: `pi-codemode-destroy-${crypto.randomUUID()}`,
        harness: "pi",
        model: "openai/gpt-5.6-sol",
        repoOwner: null,
        repoName: null,
        repoId: null,
      });
      if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
      const stub = env.PI_SESSION.getByName(sessionName);
      await recordLiveTurn(sessionName, "destroy-active-code");

      const destroyed = await runInDurableObject(stub, async (instance, state) => {
        if (!(instance instanceof PiSessionDO)) throw new Error("Expected PiSessionDO instance");
        let nestedSignal: AbortSignal | undefined;
        let nestedStarted: (() => void) | undefined;
        const waiting = new Promise<void>((resolve) => {
          nestedStarted = resolve;
        });
        const internals = instance as unknown as PiSessionInternals;
        await instance.status(sessionName);
        const read = defineTool({
          name: "read",
          description: "Block until session deletion",
          parameters: Type.Object({ path: Type.String() }),
          replay: "safe",
          async execute(_args, _api, context) {
            nestedSignal = context.abortSignal;
            nestedStarted?.();
            return new Promise((_resolve, reject) => {
              context.abortSignal?.addEventListener(
                "abort",
                () => reject(context.abortSignal?.reason),
                { once: true }
              );
            });
          },
        });
        internals.registry.install(defineExtension({ name: "test.destroy", tools: [read] }));
        const faux = fauxProvider();
        internals.models.setProvider(faux.provider);
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall("codemode", { code: 'await tools.read({ path: "wait" });' }),
            { stopReason: "toolUse" }
          ),
        ]);
        const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
        await root.configure(
          { model: { provider: "faux", modelId: "faux-1" } },
          BACKGROUND_CONTEXT
        );
        await root.submit(
          { type: "input", content: "run until deleted", requestId: "destroy-active-code" },
          BACKGROUND_CONTEXT
        );
        await waiting;
        if (interruptBeforeDestroy) await internals.codemodeSandbox?.close();
        await instance.destroy(sessionName);

        const remaining = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
          )
          .toArray()
          .map((row) => row.name);
        return {
          nestedAborted: nestedSignal?.aborted === true,
          hasPiTables: remaining.some((name) => name.startsWith("pi_")),
        };
      });

      expect(destroyed).toEqual({ nestedAborted: true, hasPiTables: false });
    },
    20_000
  );
});
