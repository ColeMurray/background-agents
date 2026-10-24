import {
  DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
  MAX_SANDBOX_COMMAND_ARGV_ITEMS,
  MAX_SANDBOX_COMMAND_TIMEOUT_MS,
  PI_SANDBOX_EXECUTION_TOOL_EFFECT_REGISTRATIONS,
  type SandboxCommandPurpose,
  type ToolEffectRegistration,
} from "@open-inspect/shared";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import type { PiToolPolicyDelegate } from "./tool-policy-types";

const APPROVAL_MEMO = "sandbox-execution-approval-v1";
const COMMAND_MEMO = "sandbox-execution-command-v1";
const APPROVAL_REVISION = 1;
const POLL_INTERVAL_MS = 250;
const MAX_MODEL_RESULT_BYTES = 64 * 1024;

export type SandboxExecutionToolRequest =
  | {
      action: "submit";
      command: {
        type: "command_execute";
        effect: "sandbox_execution";
        commandId: string;
        purpose: SandboxCommandPurpose;
        argv: string[];
        cwd?: string;
        timeoutMs?: number;
      };
      taskId: number;
      toolCallId: string;
      approvalRevision: 1;
    }
  | { action: "status"; commandId: string; afterSequence: number; limitBytes: number }
  | { action: "cancel"; commandId: string };

export interface SandboxExecutionToolResponse {
  command?: {
    id: string;
    state: string;
    outputTruncated: boolean;
    exitCode: number | null;
    signal: string | null;
    error: string | null;
  };
  chunks?: Array<{ sequence: number; stream: "stdout" | "stderr"; data: string }>;
  nextSequence?: number | null;
}

interface SandboxExecutionExtensionOptions {
  invoke(
    request: SandboxExecutionToolRequest,
    signal?: AbortSignal
  ): Promise<SandboxExecutionToolResponse>;
}

const effects: ReadonlyMap<string, ToolEffectRegistration> = new Map(
  PI_SANDBOX_EXECUTION_TOOL_EFFECT_REGISTRATIONS.map((registration) => [
    registration.name,
    registration,
  ])
);

export function createSandboxExecutionPolicyDelegate(): PiToolPolicyDelegate {
  return {
    async memoFinalAllow(call, declaration, api, context) {
      if (declaration.effect !== "sandbox_execution" || !effects.has(call.name)) return;
      const purpose = purposeForTool(call.name);
      if (!purpose) return;
      await api.memo(
        APPROVAL_MEMO,
        {
          revision: APPROVAL_REVISION,
          effect: declaration.effect,
          purpose,
        },
        context
      );
    },
  };
}

export function createSandboxExecutionExtension(options: SandboxExecutionExtensionOptions) {
  return defineExtension({
    name: "open-inspect.sandbox-execution",
    sections: [
      section(
        "sandbox_execution",
        () =>
          "Run shell, build, and test commands only in a fresh isolated sandbox. It has no repository checkout or model credentials.",
        { tag: false }
      ),
    ],
    tools: [
      executionTool("run_shell", "Run an argv command in an isolated sandbox.", "shell", options),
      executionTool("run_build", "Run a build command in an isolated sandbox.", "build", options),
      executionTool("run_tests", "Run a test command in an isolated sandbox.", "test", options),
    ],
  });
}

function executionTool(
  name: "run_shell" | "run_build" | "run_tests",
  description: string,
  purpose: SandboxCommandPurpose,
  options: SandboxExecutionExtensionOptions
) {
  const declaration = requireEffect(name);
  return defineTool({
    name,
    description,
    parameters: Type.Object({
      argv: Type.Array(Type.String({ minLength: 1, maxLength: 32 * 1024 }), {
        minItems: 1,
        maxItems: MAX_SANDBOX_COMMAND_ARGV_ITEMS,
      }),
      cwd: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4096,
          description: "Absolute path inside /workspace.",
        })
      ),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_SANDBOX_COMMAND_TIMEOUT_MS })
      ),
    }),
    structuredOutputSchema: Type.Any(),
    replay: declaration.replay,
    callers: declaration.callers,
    execute: async (args, api, context) => {
      const approval = await api.memo<{ revision: number }>(APPROVAL_MEMO, context);
      if (approval?.revision !== APPROVAL_REVISION)
        return toolError("Execution approval is missing");
      const identity = await commandIdentity(api, name, context);
      const command = {
        type: "command_execute" as const,
        effect: "sandbox_execution" as const,
        commandId: identity.commandId,
        purpose,
        argv: args.argv,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        timeoutMs: args.timeoutMs ?? DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
      };
      await options.invoke(
        {
          action: "submit",
          command,
          taskId: Number(api.taskId),
          toolCallId: api.callId,
          approvalRevision: APPROVAL_REVISION,
        },
        context.abortSignal
      );
      return waitForCommand(options, command.commandId, context);
    },
  });
}

async function commandIdentity(
  api: ToolExecutionApi,
  name: string,
  context: Context
): Promise<{ commandId: string }> {
  const candidate = {
    commandId: `exec_${await sha256Hex(`${String(api.taskId)}:${api.callId}:${name}`)}`,
  };
  return (await api.memo(COMMAND_MEMO, candidate, context)) ?? candidate;
}

async function waitForCommand(
  options: SandboxExecutionExtensionOptions,
  commandId: string,
  context: Context
) {
  let sequence = -1;
  let text = "";
  const cancel = () => {
    void options.invoke({ action: "cancel", commandId }).catch(() => undefined);
  };
  context.abortSignal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      context.abortSignal?.throwIfAborted();
      const response = await options.invoke(
        { action: "status", commandId, afterSequence: sequence, limitBytes: 64 * 1024 },
        context.abortSignal
      );
      for (const chunk of response.chunks ?? []) {
        sequence = Math.max(sequence, chunk.sequence);
        text = appendBounded(text, chunk.data, MAX_MODEL_RESULT_BYTES);
      }
      const command = response.command;
      if (!command) return toolError("Execution status is unavailable");
      if (
        ["succeeded", "failed", "cancelled", "timed_out", "indeterminate"].includes(
          command.state
        ) &&
        response.nextSequence === null
      ) {
        const result = {
          commandId,
          state: command.state,
          exitCode: command.exitCode,
          signal: command.signal,
          output: text,
          outputTruncated: command.outputTruncated || byteLength(text) >= MAX_MODEL_RESULT_BYTES,
          error: command.error,
        };
        return {
          isError: command.state !== "succeeded",
          output: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredOutput: result,
        };
      }
      await abortableDelay(POLL_INTERVAL_MS, context.abortSignal);
    }
  } finally {
    context.abortSignal?.removeEventListener("abort", cancel);
  }
}

function purposeForTool(name: string): SandboxCommandPurpose | undefined {
  return name === "run_shell"
    ? "shell"
    : name === "run_build"
      ? "build"
      : name === "run_tests"
        ? "test"
        : undefined;
}

function requireEffect(name: string): ToolEffectRegistration {
  const declaration = effects.get(name);
  if (!declaration) throw new Error(`Sandbox execution tool has no effect declaration: ${name}`);
  return declaration;
}

function appendBounded(current: string, addition: string, maxBytes: number): string {
  const remaining = maxBytes - byteLength(current);
  if (remaining <= 0) return current;
  const bytes = new TextEncoder().encode(addition);
  return current + new TextDecoder().decode(bytes.slice(0, remaining));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toolError(message: string) {
  return { isError: true, output: [{ type: "text" as const, text: message }] };
}
