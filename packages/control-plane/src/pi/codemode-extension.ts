import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import { CODEMODE_OPTIONS_PREFIX, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { defineExtension, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { Context, JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import type { PiToolPolicyDelegate } from "./tool-policy-extension";

export const CODEMODE_DEFAULT_TIMEOUT_MS = 60_000;
export const CODEMODE_MAX_TIMEOUT_MS = 300_000;
export const CODEMODE_MAX_QUEUED_CALLS = 16;
const DEADLINE_MEMO = "open-inspect.codemode.deadline.v1";
const ADMISSION_MEMO = "open-inspect.codemode.admission.v1";

const codeModeArgsSchema = z.strictObject({ code: z.string().min(1) });
const codeModeDeadlineMemoSchema = z.strictObject({
  version: z.literal(1),
  taskId: z.number().int().nonnegative(),
  deadlineMs: z.number().int().positive(),
});
const codeModeAdmissionMemoSchema = z.strictObject({
  version: z.literal(1),
  taskId: z.number().int().nonnegative(),
});
type CodeModeDeadlineMemo = z.infer<typeof codeModeDeadlineMemoSchema>;

interface QueueEntry {
  deadlineMs: number;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

export interface PiCodeModePolicyState {
  readonly activeTasks: Map<TaskId, string>;
  readonly coordinator: PiCodeModeExecutionCoordinator;
  readonly authorizeStart: (signal?: AbortSignal) => Promise<void>;
}

export interface PiCodeModePolicyOptions {
  coordinator?: PiCodeModeExecutionCoordinator;
  authorizeStart?: (signal?: AbortSignal) => Promise<void>;
}

/** One fair, abort-aware Code Mode execution lane shared by every conversation in a Pi session. */
export class PiCodeModeExecutionCoordinator {
  private active = false;
  private readonly queue: QueueEntry[] = [];
  private readonly activeSettlements = new Set<Promise<void>>();
  private closed: Error | undefined;

  async run<T>(
    deadlineMs: number,
    signal: AbortSignal | undefined,
    execute: () => Promise<T>
  ): Promise<T> {
    const invocation = (async () => {
      await this.acquire(deadlineMs, signal);
      try {
        return await execute();
      } finally {
        this.release();
      }
    })();
    const settlement = invocation.then(
      () => undefined,
      () => undefined
    );
    this.activeSettlements.add(settlement);
    try {
      return await invocation;
    } finally {
      this.activeSettlements.delete(settlement);
    }
  }

  /** Reject queued calls and wait until the active host invocation has actually settled. */
  async close(reason: Error): Promise<void> {
    this.closed ??= reason;
    for (const entry of this.queue.splice(0)) {
      this.detach(entry);
      entry.reject(this.closed);
    }
    await Promise.allSettled([...this.activeSettlements]);
  }

  snapshot(): { active: boolean; queued: number; closed: boolean } {
    return { active: this.active, queued: this.queue.length, closed: this.closed !== undefined };
  }

  private acquire(deadlineMs: number, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (deadlineMs <= Date.now()) return Promise.reject(deadlineError());
    if (!this.active) {
      this.active = true;
      return Promise.resolve();
    }
    if (this.queue.length >= CODEMODE_MAX_QUEUED_CALLS) {
      return Promise.reject(new Error("Code Mode session queue is full"));
    }
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { deadlineMs, signal, resolve, reject };
      const waitMs = Math.max(1, deadlineMs - Date.now());
      entry.timer = setTimeout(() => this.rejectQueued(entry, deadlineError()), waitMs);
      if (signal) {
        entry.onAbort = () => this.rejectQueued(entry, abortError(signal));
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  private release(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.detach(next);
      if (next.signal?.aborted) {
        next.reject(abortError(next.signal));
        continue;
      }
      if (next.deadlineMs <= Date.now()) {
        next.reject(deadlineError());
        continue;
      }
      next.resolve();
      return;
    }
    this.active = false;
  }

  private rejectQueued(entry: QueueEntry, error: Error): void {
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.detach(entry);
    entry.reject(error);
  }

  private detach(entry: QueueEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }
}

export function createPiCodeModePolicyState(
  options: PiCodeModePolicyOptions = {}
): PiCodeModePolicyState {
  return {
    activeTasks: new Map(),
    coordinator: options.coordinator ?? new PiCodeModeExecutionCoordinator(),
    authorizeStart: options.authorizeStart ?? (async () => {}),
  };
}

/** Code Mode decisions composed through the one canonical policy extension. */
export function createPiCodeModePolicyDelegate(state: PiCodeModePolicyState): PiToolPolicyDelegate {
  return {
    beforeTool: async (call, declaration) => {
      if (call.parent && state.activeTasks.get(call.parent.taskId) === call.parent.callId) {
        const read = declaration.effect === "local_read" || declaration.effect === "external_read";
        if (!read || declaration.replay !== "safe") {
          return { block: "Code Mode may call only replay-safe read tools" };
        }
      }
      return undefined;
    },
  };
}

/** Native Code Mode with task-bound policy, absolute deadlines, and one session execution lane. */
export function createOpenInspectCodemodeExtension(
  sandbox: CodemodeSandboxBase,
  policy: PiCodeModePolicyState
) {
  const extension = createCodemodeExtension({ sandbox });
  return defineExtension({
    ...extension,
    tools: extension.tools?.map((tool) =>
      tool.name !== "codemode"
        ? tool
        : {
            ...tool,
            async execute(args, api, context) {
              const input = codeModeArgsSchema.parse(args);
              const deadline = await codeModeDeadline(input.code, api, context);
              return policy.coordinator.run(deadline.deadlineMs, context.abortSignal, async () => {
                let admitted = await api.memo<JsonValue>(ADMISSION_MEMO, context);
                if (admitted === undefined) {
                  await policy.authorizeStart(context.abortSignal);
                  admitted = await api.memo(
                    ADMISSION_MEMO,
                    { version: 1, taskId: Number(api.taskId) },
                    context
                  );
                }
                const parsedAdmission = codeModeAdmissionMemoSchema.safeParse(admitted);
                if (
                  !parsedAdmission.success ||
                  parsedAdmission.data.taskId !== Number(api.taskId)
                ) {
                  throw new Error("Code Mode admission authority is invalid");
                }
                const remainingMs = deadline.deadlineMs - Date.now();
                if (remainingMs <= 0) throw deadlineError();
                policy.activeTasks.set(api.taskId, api.callId);
                try {
                  return await tool.execute(
                    { code: sourceWithDeadline(input.code, remainingMs) },
                    api,
                    context
                  );
                } finally {
                  policy.activeTasks.delete(api.taskId);
                }
              });
            },
          }
    ),
  });
}

async function codeModeDeadline(
  source: string,
  api: ToolExecutionApi,
  context: Context
): Promise<CodeModeDeadlineMemo> {
  const parsed = parseCodemodeSource(source);
  const timeoutMs = Math.min(
    parsed.options.timeoutMs ?? CODEMODE_DEFAULT_TIMEOUT_MS,
    CODEMODE_MAX_TIMEOUT_MS
  );
  const candidate: CodeModeDeadlineMemo = {
    version: 1,
    taskId: Number(api.taskId),
    deadlineMs: Date.now() + timeoutMs,
  };
  const stored = await api.memo<JsonValue>(DEADLINE_MEMO, candidate, context);
  const parsedMemo = codeModeDeadlineMemoSchema.safeParse(stored);
  if (!parsedMemo.success || parsedMemo.data.taskId !== Number(api.taskId)) {
    throw new Error("Code Mode deadline authority is invalid");
  }
  return parsedMemo.data;
}

function sourceWithDeadline(source: string, remainingMs: number): string {
  const parsed = parseCodemodeSource(source);
  const options = {
    ...(parsed.options.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: parsed.options.maxOutputTokens }),
    timeout_ms: Math.max(1, Math.floor(remainingMs)),
  };
  const body = source.startsWith(CODEMODE_OPTIONS_PREFIX)
    ? parsed.code.slice(parsed.code.indexOf("\n") + 1)
    : parsed.code;
  return `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify(options)}\n${body}`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Code Mode call was aborted");
}

function deadlineError(): Error {
  return new Error(
    "Code Mode absolute deadline expired while waiting for the session execution lane"
  );
}
