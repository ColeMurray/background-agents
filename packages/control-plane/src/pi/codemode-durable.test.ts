import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
  resolvePiFeatureCapabilities,
} from "@open-inspect/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenInspectCodemodeExtension,
  createPiCodeModePolicyDelegate,
  createPiCodeModePolicyState,
} from "./codemode-extension";
import { assemblePiExtensions } from "./extension-assembler";
import { createPiToolPolicyExtension } from "./tool-policy-extension";
import { createPiDeploymentEmergencyPolicy } from "./deployment-emergency-policy";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function databasePath(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `open-inspect-${label}-`));
  directories.push(directory);
  return join(directory, "pi.sqlite");
}

type CodeModeAdmission = boolean | ((signal: AbortSignal | undefined) => Promise<boolean>);

function registryWith(
  sandbox: CodemodeSandbox,
  read: ToolRegistration,
  admission: CodeModeAdmission = true
) {
  const registry = createRegistry();
  const readExtension = defineExtension({ name: "test.read", tools: [read] });
  const resolveAdmission = async (signal: AbortSignal | undefined) =>
    typeof admission === "boolean" ? admission : await admission(signal);
  const codeModePolicy = createPiCodeModePolicyState({
    authorizeStart: async (signal) => {
      if (!(await resolveAdmission(signal))) {
        throw new Error("Code Mode is disabled for new calls by deployment policy");
      }
    },
  });
  const codeMode = createOpenInspectCodemodeExtension(sandbox, codeModePolicy);
  const assembly = assemblePiExtensions(
    [
      {
        slot: "policy",
        effects: [],
        createExtension: (effects) =>
          createPiToolPolicyExtension(
            effects,
            [createPiCodeModePolicyDelegate(codeModePolicy)],
            createPiDeploymentEmergencyPolicy(async (signal) => {
              const admit = await resolveAdmission(signal);
              return resolvePiFeatureCapabilities({ codeMode: admit ? "enabled" : "off" });
            })
          ),
      },
      {
        slot: "core",
        extension: readExtension,
        effects: [
          {
            name: "read",
            effect: "local_read",
            callers: ["model", "tools"],
            replay: "safe",
          },
        ],
      },
      {
        slot: "code_mode",
        feature: "codeMode",
        minimumCapability: "enabled",
        extension: codeMode,
        effects: PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
      },
    ],
    resolvePiFeatureCapabilities({ codeMode: "enabled" })
  );
  for (const extension of assembly.extensions) registry.install(extension);
  return registry;
}

function readTool(
  execute: (
    args: { path: string },
    api: ToolExecutionApi,
    context: Context
  ) => Promise<ToolExecutionResult>
): ToolRegistration {
  return defineTool({
    name: "read",
    description: "Read test data",
    parameters: Type.Object({ path: Type.String() }),
    replay: "safe",
    execute,
  });
}

describe("native durable Code Mode", () => {
  it("continues execute-phase replay under current emergency deny", async () => {
    const path = await databasePath("codemode-replay");
    let firstReads = 0;
    let secondReads = 0;
    let secondStarted: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const firstSandbox = new CodemodeSandbox();
    const firstRead = readTool(async (args, _api, context) => {
      const requested = String(args.path);
      if (requested === "first") {
        firstReads++;
        return { output: [{ type: "text", text: "first-result" }] };
      }
      secondReads++;
      secondStarted?.();
      return new Promise((_resolve, reject) => {
        context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), {
          once: true,
        });
      });
    });
    const firstModels = createModels();
    const firstFaux = fauxProvider();
    firstModels.setProvider(firstFaux.provider);
    firstFaux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'const first = await tools.read({ path: "first" }); const second = await tools.read({ path: "second" }); return first + ":" + second;',
        }),
        { stopReason: "toolUse" }
      ),
    ]);
    const firstHarness = await Harness.open(
      await openNodeSqliteStorage(path),
      { models: firstModels, registry: registryWith(firstSandbox, firstRead) },
      BACKGROUND_CONTEXT
    );
    const firstRoot = await firstHarness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    const submission = await firstRoot.submit(
      { type: "input", content: "run code mode", requestId: "codemode-replay" },
      BACKGROUND_CONTEXT
    );
    await waiting;

    await firstSandbox.close();
    await firstHarness.close(BACKGROUND_CONTEXT);

    const replaySandbox = new CodemodeSandbox();
    const replayRead = readTool(async (args) => {
      const requested = String(args.path);
      if (requested === "first") {
        firstReads++;
        return { output: [{ type: "text", text: "duplicate-first" }] };
      }
      secondReads++;
      return { output: [{ type: "text", text: "second-result" }] };
    });
    const replayModels = createModels();
    const replayFaux = fauxProvider();
    replayModels.setProvider(replayFaux.provider);
    replayFaux.setResponses([fauxAssistantMessage("finished")]);
    const replayHarness = await Harness.open(
      await openNodeSqliteStorage(path),
      { models: replayModels, registry: registryWith(replaySandbox, replayRead, false) },
      BACKGROUND_CONTEXT
    );
    replayHarness.resume();
    const resumed = await replayHarness.submission(submission.id, BACKGROUND_CONTEXT);

    await expect(resumed?.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({ status: "done" });
    expect(firstReads).toBe(1);
    expect(secondReads).toBe(2);

    await replaySandbox.close();
    await replayHarness.close(BACKGROUND_CONTEXT);
  }, 20_000);

  it("reruns current emergency policy for call-phase recovery before durable intent", async () => {
    const path = await databasePath("codemode-call-phase");
    const read = readTool(async () => ({ output: [{ type: "text", text: "unused" }] }));
    const crash = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", CALL_PHASE_CRASH_SCRIPT, path],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 }
    );
    expect(crash.status, crash.stderr).toBe(17);

    const replaySandbox = new CodemodeSandbox();
    const replayModels = createModels();
    const replayFaux = fauxProvider();
    replayModels.setProvider(replayFaux.provider);
    replayFaux.setResponses([fauxAssistantMessage("finished")]);
    const replayStorage = await openNodeSqliteStorage(path);
    const replayHarness = await Harness.open(
      replayStorage,
      { models: replayModels, registry: registryWith(replaySandbox, read, false) },
      BACKGROUND_CONTEXT
    );
    replayHarness.resume();
    const replayRoot = await replayHarness.root(BACKGROUND_CONTEXT);
    const submission = await replayStorage.submissionByRequest(
      replayRoot.id,
      "codemode-call-phase",
      BACKGROUND_CONTEXT
    );
    if (!submission) throw new Error("Crash fixture did not persist its submission");
    const resumed = await replayHarness.submission(submission.id, BACKGROUND_CONTEXT);
    await expect(resumed?.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({ status: "done" });
    const view = await replayRoot.context(BACKGROUND_CONTEXT);
    const result = view.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "codemode"
    );
    expect(result?.role).toBe("toolResult");
    expect(
      result?.role === "toolResult"
        ? result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        : ""
    ).toContain("disabled for new calls by deployment policy");

    await replaySandbox.close();
    await replayHarness.close(BACKGROUND_CONTEXT);
  }, 20_000);

  it("aborts the active script and its nested call", async () => {
    const path = await databasePath("codemode-abort");
    let nestedSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sandbox = new CodemodeSandbox();
    const read = readTool(async (_args, _api, context) => {
      nestedSignal = context.abortSignal;
      started?.();
      return new Promise((_resolve, reject) => {
        context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), {
          once: true,
        });
      });
    });
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", { code: 'await tools.read({ path: "wait" });' }),
        { stopReason: "toolUse" }
      ),
    ]);
    const harness = await Harness.open(
      await openNodeSqliteStorage(path),
      { models, registry: registryWith(sandbox, read) },
      BACKGROUND_CONTEXT
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    const submission = await root.submit(
      { type: "input", content: "abort code mode", requestId: "codemode-abort" },
      BACKGROUND_CONTEXT
    );
    await waiting;

    await root.abort(BACKGROUND_CONTEXT);

    await expect(submission.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({
      status: "unanswered",
    });
    expect(nestedSignal?.aborted).toBe(true);
    await sandbox.close();
    await harness.close(BACKGROUND_CONTEXT);
  }, 20_000);
});

const CALL_PHASE_CRASH_SCRIPT = String.raw`
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createRegistry, defineExtension, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const path = process.argv[1];
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("codemode", { code: "return 1;" }), { stopReason: "toolUse" }),
]);
const registry = createRegistry();
registry.install(defineExtension({
  name: "test.crash-before-codemode-intent",
  hooks: [hook(ToolTask, {
    beforeTool(call) {
      if (call.name === "codemode") process.exit(17);
    },
  })],
}));
registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, BACKGROUND_CONTEXT);
const root = await harness.root(BACKGROUND_CONTEXT, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});
await root.submit(
  { type: "input", content: "crash before intent", requestId: "codemode-call-phase" },
  BACKGROUND_CONTEXT,
);
await new Promise((resolve) => setTimeout(resolve, 5_000));
process.exit(18);
`;
