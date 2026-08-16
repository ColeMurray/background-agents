import { readFileSync } from "node:fs";
import { expect, expectTypeOf, it } from "vitest";
import type {
  AppendEvent,
  CompactEvent,
  CreatePromptInput,
  CreatePromptResult,
  HistoryQuery,
  PendingEvent,
  PersistedEvent,
  PromptClaim,
  PromptUpdate,
  SandboxRecord,
  SandboxUpdate,
  SessionHistory,
  SessionRecord,
  SessionStore,
  UpsertEvent,
} from "./session-store";

it("does not expose persistence providers or transaction primitives", () => {
  const source = readFileSync(new URL("./session-store.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

  expect(specifiers).not.toHaveLength(0);
  for (const specifier of specifiers) {
    expect(specifier).toMatch(/^@open-inspect\/shared\/types\//);
  }
});

it("defines the provider-neutral asynchronous session store contract", () => {
  type ExpectedMethods =
    | "getSession"
    | "appendEvents"
    | "createPrompt"
    | "claimNextPrompt"
    | "updatePrompt"
    | "getSandbox"
    | "updateSandbox"
    | "getHistory";

  expectTypeOf<keyof SessionStore>().toEqualTypeOf<ExpectedMethods>();
  expectTypeOf<SessionStore["getSession"]>().returns.toEqualTypeOf<Promise<SessionRecord>>();
  expectTypeOf<SessionStore["appendEvents"]>().parameter(0).toEqualTypeOf<PendingEvent[]>();
  expectTypeOf<SessionStore["appendEvents"]>().returns.toEqualTypeOf<Promise<PersistedEvent[]>>();
  expectTypeOf<SessionStore["createPrompt"]>().parameter(0).toEqualTypeOf<CreatePromptInput>();
  expectTypeOf<SessionStore["createPrompt"]>().returns.toEqualTypeOf<Promise<CreatePromptResult>>();
  expectTypeOf<SessionStore["claimNextPrompt"]>().returns.toEqualTypeOf<
    Promise<PromptClaim | null>
  >();
  expectTypeOf<SessionStore["updatePrompt"]>().parameter(0).toEqualTypeOf<PromptUpdate>();
  expectTypeOf<SessionStore["updatePrompt"]>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<SessionStore["getSandbox"]>().returns.toEqualTypeOf<Promise<SandboxRecord | null>>();
  expectTypeOf<SessionStore["updateSandbox"]>().parameter(0).toEqualTypeOf<SandboxUpdate>();
  expectTypeOf<SessionStore["updateSandbox"]>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<SessionStore["getHistory"]>().parameter(0).toEqualTypeOf<HistoryQuery>();
  expectTypeOf<SessionStore["getHistory"]>().returns.toEqualTypeOf<Promise<SessionHistory>>();
});

it("represents current atomic operations without storage primitives", () => {
  const append = {
    operation: "append",
    id: "event-1",
    event: {
      type: "tool_result",
      sandboxId: "sandbox-1",
      messageId: "prompt-1",
      timestamp: 1,
      callId: "call-1",
      result: "done",
    },
    createdAt: 1_000,
  } satisfies AppendEvent;
  const upsert = {
    operation: "upsert",
    event: {
      type: "token",
      sandboxId: "sandbox-1",
      messageId: "prompt-1",
      timestamp: 2,
      content: "hello",
    },
    createdAt: 2_000,
  } satisfies UpsertEvent;
  const compact = {
    operation: "compact",
    id: "compaction-1",
    event: {
      type: "context_compacted",
      sandboxId: "sandbox-1",
      messageId: "prompt-1",
      timestamp: 3,
    },
    createdAt: 3_000,
  } satisfies CompactEvent;
  const create = {
    prompt: {
      id: "prompt-1",
      authorId: "participant-1",
      content: "Fix it",
      source: "web",
      model: null,
      reasoningEffort: null,
      callbackContext: null,
      clientRequestId: "request-1",
      requestFingerprint: "fingerprint-1",
      createdAt: 1_000,
    },
    attachments: [{ attachmentId: "attachment-1", name: "screenshot.png", mimeType: "image/png" }],
    maxUnfinishedPrompts: 10,
  } satisfies CreatePromptInput;
  const start = {
    type: "start",
    claimId: "claim-1",
    startedAt: 2_000,
    event: {
      operation: "append",
      id: "user_message:prompt-1",
      event: { type: "user_message", content: "Fix it", messageId: "prompt-1", timestamp: 2 },
      createdAt: 2_000,
    },
  } satisfies PromptUpdate;
  const complete = {
    type: "complete",
    expectedStatus: "processing",
    event: {
      operation: "upsert",
      createdAt: 3_000,
      event: {
        type: "execution_complete",
        sandboxId: "sandbox-1",
        messageId: "prompt-1",
        timestamp: 3,
        success: true,
      },
    },
  } satisfies PromptUpdate;
  const accessUpdate = {
    type: "set-code-server-access",
    url: null,
  } satisfies SandboxUpdate;
  const circuitBreakerUpdate = {
    type: "record-spawn-failure",
    failedAt: 4_000,
  } satisfies SandboxUpdate;
  const history = {
    limit: 100,
    filter: { type: "for-prompt", promptId: "prompt-1" },
  } satisfies HistoryQuery;

  const writes = [append, upsert, compact] satisfies PendingEvent[];
  expect(writes).toHaveLength(3);
  expect([create, start, complete, accessUpdate, circuitBreakerUpdate, history]).toHaveLength(6);
});

it("preserves nullable legacy repository state", () => {
  expectTypeOf<SessionRecord["repositories"][number]["baseBranch"]>().toEqualTypeOf<
    string | null
  >();
});

it("models create outcomes explicitly", () => {
  expectTypeOf<CreatePromptResult["outcome"]>().toEqualTypeOf<
    | "created"
    | "duplicate"
    | "request-conflict"
    | "attachment-conflict"
    | "queue-full"
    | "session-not-promptable"
  >();
});

it("prevents lifecycle events from bypassing their atomic operations", () => {
  expectTypeOf<
    Extract<AppendEvent["event"], { type: "context_compacted" }>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<AppendEvent["event"], { type: "execution_complete" }>
  >().toEqualTypeOf<never>();
  expectTypeOf<Extract<AppendEvent["event"], { type: "user_message" }>>().toEqualTypeOf<never>();
});
