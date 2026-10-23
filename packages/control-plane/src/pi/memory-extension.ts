import { Type, type Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { PI_MEMORY_TOOL_EFFECT_REGISTRATIONS } from "@open-inspect/shared";
import type { FeatureCapabilityMode } from "@open-inspect/shared/capability-modes";
import { MEMORY_TOOLS, harnessMemoryToolName } from "@open-inspect/shared/memory-tools";
import type {
  MemorySearchInput,
  MemorySearchResponse,
  SandboxMemoryReadResult,
  SandboxMemoryWriteInput,
  SandboxMemoryWriteResult,
} from "@open-inspect/shared/types/memories";

/**
 * The Pi-visible names of the memory tools.
 *
 * They are the shared contract's own names, so Pi and the sandbox harnesses
 * expose one canonical set and the memory framing the control plane renders
 * already names the right tools for this harness.
 */
export const PI_MEMORY_TOOL_NAMES = {
  read: harnessMemoryToolName("pi", "memory_read"),
  write: harnessMemoryToolName("pi", "memory_write"),
  search: harnessMemoryToolName("pi", "memory_search"),
} as const;

function declaredEffect(name: string) {
  const registration = PI_MEMORY_TOOL_EFFECT_REGISTRATIONS.find(
    (candidate) => candidate.name === name
  );
  if (!registration) throw new Error(`Tool has no effect declaration: ${name}`);
  return registration;
}

/**
 * The argument schemas, as the model sees them.
 *
 * The shared contract owns the semantics; these are the same shapes in the
 * form the Pi registry takes. `memory-extension.test.ts` proves the two agree
 * field by field, so a change to the contract cannot drift away from the tool
 * the model calls.
 */
export const memoryReadParameters = Type.Object(
  {
    memoryId: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "Memory ID from the catalog or memory_search",
    }),
  },
  { additionalProperties: false }
);

export const memoryWriteParameters = Type.Object(
  {
    memoryType: Type.Union([Type.Literal("fact"), Type.Literal("directive")]),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 10, maxLength: 420 }),
    content: Type.String({ minLength: 1, maxLength: 20_000 }),
    scopeType: Type.Union(
      [Type.Literal("personal"), Type.Literal("repository"), Type.Literal("environment")],
      { description: "Where to store the memory, relative to this session" }
    ),
    repoOwner: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Repository owner; supply with repoName to pick one of several session repositories",
      })
    ),
    repoName: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Repository name; supply with repoOwner to pick one of several session repositories",
      })
    ),
    supersedesMemoryId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Active memory in the same scope that this one replaces",
      })
    ),
  },
  { additionalProperties: false }
);

export const memorySearchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 2,
      maxLength: 256,
      description: "Short literal keywords; every term must match",
    }),
    scopeType: Type.Optional(
      Type.Union(
        [Type.Literal("personal"), Type.Literal("repository"), Type.Literal("environment")],
        {
          description: "Restrict to one scope type; omit to search every permitted session scope",
        }
      )
    ),
    repoOwner: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Repository owner; supply with repoName to pick one of several session repositories",
      })
    ),
    repoName: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Repository name; supply with repoOwner to pick one of several session repositories",
      })
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
  },
  { additionalProperties: false }
);

/**
 * The session's memory, reached only through the owning session.
 *
 * The agent never holds a credential and never names a scope it was not
 * given: the session resolves the identity, the partition, and the access
 * policy, and returns a bounded, credential-free result.
 */
export interface MemoryToolClient {
  read(request: { memoryId: string }, signal?: AbortSignal): Promise<SandboxMemoryReadResult>;
  write(request: SandboxMemoryWriteInput, signal?: AbortSignal): Promise<SandboxMemoryWriteResult>;
  search(request: MemorySearchInput, signal?: AbortSignal): Promise<MemorySearchResponse>;
}

export interface MemoryExtensionOptions {
  client: MemoryToolClient;
  /** Reauthorize and render the session's pinned memory for one model request. */
  currentMemory(signal?: AbortSignal): Promise<{ rendered: string } | null>;
  /**
   * The capability this session was admitted with.
   *
   * A read-only capability admits the reads alone: the model may consult the
   * tenant's memory, and may not change it.
   */
  mode: FeatureCapabilityMode;
}

function shownMemory(messages: readonly Message[]): string | undefined {
  let rendered: string | undefined;
  for (const message of messages) {
    if (message.role !== "system" || message.sections?.memory === undefined) continue;
    rendered = message.sections.memory ?? undefined;
  }
  return rendered;
}

/**
 * The agent's memory tools.
 *
 * The same three tools the sandbox harnesses expose, over the same authority:
 * the session's own memory, the session's own selection, and the session's own
 * access policy. A write to a shared scope comes back as a proposal a person
 * approves; the result says which it was.
 */
export function createMemoryExtension(options: MemoryExtensionOptions) {
  const readEffect = declaredEffect(PI_MEMORY_TOOL_NAMES.read);
  const writeEffect = declaredEffect(PI_MEMORY_TOOL_NAMES.write);
  const searchEffect = declaredEffect(PI_MEMORY_TOOL_NAMES.search);
  const tools: ToolRegistration[] = [
    defineTool({
      name: PI_MEMORY_TOOL_NAMES.read,
      description: MEMORY_TOOLS.memory_read.description,
      parameters: memoryReadParameters,
      structuredOutputSchema: Type.Any(),
      replay: readEffect.replay,
      callers: readEffect.callers,
      execute: async (args, _api, context) => {
        const result = await options.client.read({ memoryId: args.memoryId }, context.abortSignal);
        return {
          isError: false,
          output: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredOutput: result as unknown as JsonValue,
          details: { id: result.id, status: result.status },
        };
      },
    }),
    defineTool({
      name: PI_MEMORY_TOOL_NAMES.search,
      description: MEMORY_TOOLS.memory_search.description,
      parameters: memorySearchParameters,
      structuredOutputSchema: Type.Any(),
      replay: searchEffect.replay,
      callers: searchEffect.callers,
      execute: async (args, _api, context) => {
        const result = await options.client.search(args as MemorySearchInput, context.abortSignal);
        return {
          isError: false,
          output: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredOutput: result as unknown as JsonValue,
          details: { count: result.results.length, hasMore: result.hasMore },
        };
      },
    }),
  ];
  if (options.mode === "enabled") {
    tools.push(
      defineTool({
        name: PI_MEMORY_TOOL_NAMES.write,
        description: MEMORY_TOOLS.memory_write.description,
        parameters: memoryWriteParameters,
        structuredOutputSchema: Type.Any(),
        replay: writeEffect.replay,
        callers: writeEffect.callers,
        execute: async (args, _api, context) => {
          const result = await options.client.write(
            args as SandboxMemoryWriteInput,
            context.abortSignal
          );
          return {
            isError: false,
            output: [
              {
                type: "text" as const,
                text:
                  result.status === "active"
                    ? "The memory is stored."
                    : "The memory was recorded as a proposal and needs a person's approval.",
              },
            ],
            structuredOutput: result as unknown as JsonValue,
            details: { id: result.id, status: result.status },
          };
        },
      })
    );
  }
  return defineExtension({
    name: "open-inspect.memory",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, _api, context) => {
          // This runs for every provider attempt. The owning session re-reads
          // the operation's current human author and memory access before it
          // returns any text. A rejected or unavailable lookup throws here,
          // so Pi never falls back to a previously rendered section.
          const current = await options.currentMemory(context.abortSignal);
          const rendered = current?.rendered || undefined;
          if (shownMemory(messages) === rendered) return undefined;
          return {
            messages: [
              ...messages,
              {
                role: "system" as const,
                content: "",
                sections: { memory: rendered ?? null },
                timestamp: Date.now(),
              },
            ],
          };
        },
      }),
    ],
    tools,
  });
}
