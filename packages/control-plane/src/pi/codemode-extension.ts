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
  /** The durable record of which Code Mode task is running. */
  readonly parents: CodeModeParentRegistry;
  readonly coordinator: PiCodeModeExecutionCoordinator;
  readonly authorizeStart: (signal?: AbortSignal) => Promise<void>;
}

export interface PiCodeModePolicyOptions {
  coordinator?: PiCodeModeExecutionCoordinator;
  authorizeStart?: (signal?: AbortSignal) => Promise<void>;
  parents?: CodeModeParentRegistry;
}

/**
 * The durable record of the running Code Mode tasks.
 *
 * The restriction on what a nested call may do must survive a Durable Object
 * eviction. A nested task that the scheduler resumes after an eviction has to
 * learn that its parent is a Code Mode task from durable state, not from a map
 * that only exists while the object is awake.
 */
export interface CodeModeParentRegistry {
  /** The call id of the Code Mode task with this id, if one is running. */
  get(taskId: TaskId): Promise<string | undefined>;
  set(taskId: TaskId, callId: string): Promise<void>;
  remove(taskId: TaskId): Promise<void>;
}

/** The storage surface a durable registry needs. */
export interface CodeModeParentStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const CODE_MODE_PARENT_KEY_PREFIX = "open-inspect:codemode-parent:";

function codeModeParentKey(taskId: TaskId): string {
  return `${CODE_MODE_PARENT_KEY_PREFIX}${String(taskId)}`;
}

/** The registry backed by the Durable Object's own storage. */
export function createDurableCodeModeParentRegistry(
  storage: CodeModeParentStorage
): CodeModeParentRegistry {
  return {
    async get(taskId) {
      const value = await storage.get(codeModeParentKey(taskId));
      return typeof value === "string" ? value : undefined;
    },
    async set(taskId, callId) {
      await storage.put(codeModeParentKey(taskId), callId);
    },
    async remove(taskId) {
      await storage.delete(codeModeParentKey(taskId));
    },
  };
}

/** The registry used when no durable storage is available. */
export function createMemoryCodeModeParentRegistry(): CodeModeParentRegistry {
  const parents = new Map<string, string>();
  return {
    async get(taskId) {
      return parents.get(String(taskId));
    },
    async set(taskId, callId) {
      parents.set(String(taskId), callId);
    },
    async remove(taskId) {
      parents.delete(String(taskId));
    },
  };
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
    parents: options.parents ?? createMemoryCodeModeParentRegistry(),
    coordinator: options.coordinator ?? new PiCodeModeExecutionCoordinator(),
    authorizeStart: options.authorizeStart ?? (async () => {}),
  };
}

/** Code Mode decisions composed through the one canonical policy extension. */
export function createPiCodeModePolicyDelegate(state: PiCodeModePolicyState): PiToolPolicyDelegate {
  return {
    beforeTool: async (call, declaration) => {
      if (!call.parent) return undefined;
      // The parentage is *proven*, not assumed. A nested call whose parent
      // record does not match is refused: the rule that limits a script to
      // replay-safe reads must not disappear when the record is missing or
      // stale.
      const parentCallId = await state.parents.get(call.parent.taskId);
      if (parentCallId !== call.parent.callId) {
        return { block: "Code Mode may call only tools of its own run" };
      }
      const read = declaration.effect === "local_read" || declaration.effect === "external_read";
      if (!read || declaration.replay !== "safe") {
        return { block: "Code Mode may call only replay-safe read tools" };
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
  // The scripts get no model surface at all: no catalog globals, and no
  // model-call tools. Those tools would send model-written context to the
  // provider with the session's credential, which is exactly what a
  // capability must never do.
  const extension = createCodemodeExtension({ sandbox, models: false });
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
                await policy.parents.set(api.taskId, api.callId);
                try {
                  return await tool.execute(
                    { code: sourceWithDeadline(input.code, remainingMs) },
                    api,
                    context
                  );
                } finally {
                  await policy.parents.remove(api.taskId);
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
