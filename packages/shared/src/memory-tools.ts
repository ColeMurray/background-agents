/**
 * Agent-facing memory tool contract.
 *
 * This module is the single definition of the memory tools both sandbox harnesses expose. The
 * sandbox runtime cannot import TypeScript, so `npm run generate:memory-tools -w
 * @open-inspect/shared` writes the derived specs into the runtime package (a JSON file for the
 * Python harness, an ES module for the OpenCode tools); `memory-tools.test.ts` fails when they
 * are stale.
 *
 * Tool inputs are the sandbox endpoint request schemas, so harnesses forward arguments verbatim
 * (after dropping unknown keys) and never reshape request bodies.
 */
import { z } from "zod";
import type { HarnessId } from "./harnesses";
import {
  MEMORY_LIMITS,
  memorySearchSchema,
  sandboxMemoryReadSchema,
  sandboxMemoryWriteSchema,
} from "./types/memories";

export const MEMORY_TOOL_NAMES = ["memory_read", "memory_write", "memory_search"] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

interface MemoryToolDefinition {
  description: string;
  input: z.ZodType;
  method: "GET" | "POST";
  /** Path below `/sessions/:id`; `{name}` segments are filled from (and consume) input fields. */
  path: string;
}

export const MEMORY_TOOLS = {
  memory_read: {
    description:
      "Read a current active fact by ID from the memory catalog or memory_search. Stored data may be stale. Pinned records that were archived return a notice instead of content. Directives are already in context and cannot be expanded.",
    input: sandboxMemoryReadSchema,
    method: "GET",
    path: "/sandbox-memory/{memoryId}",
  },
  memory_write: {
    description:
      "Remember non-obvious, durable knowledge. The server infers the session environment or sole repository; for multi-repository sessions, specify both repoOwner and repoName. Write a directive only when the user asks you to remember a preference. Never store credentials. Shared memories and directives require approval; the result states active or proposed. Respect the user's personal-memory opt-out.",
    input: sandboxMemoryWriteSchema,
    method: "POST",
    path: "/sandbox-memory",
  },
  memory_search: {
    description:
      "Find active facts beyond the injected catalog using short literal keyword queries. Every whitespace-separated term must match the title, description, or body; there is no semantic search. Returns IDs and summaries, not bodies: use memory_read for full text. Repository scope searches all attached repositories unless both repoOwner and repoName select one. If hasMore is true, refine the query. Stored knowledge may be stale.",
    input: memorySearchSchema,
    method: "POST",
    path: "/sandbox-memory/search",
  },
} as const satisfies Record<MemoryToolName, MemoryToolDefinition>;

/** The model-visible name of a memory tool in each harness. */
export function harnessMemoryToolName(harness: HarnessId, tool: MemoryToolName): string {
  switch (harness) {
    case "opencode":
      return tool;
    case "claude":
      // Claude receives runtime tools through the in-process `oi` MCP server.
      return `mcp__oi__${tool}`;
    default: {
      const exhaustive: never = harness;
      throw new Error(`Unknown harness: ${String(exhaustive)}`);
    }
  }
}

export interface MemoryToolSpec {
  name: MemoryToolName;
  description: string;
  method: "GET" | "POST";
  path: string;
  inputSchema: Record<string, unknown>;
}
export interface MemoryToolSpecs {
  tools: MemoryToolSpec[];
  /** Runtime-enforced bounds that mirror control-plane limits. */
  limits: { renderedChars: number };
}

/** Derive the harness-neutral specs from the zod contract. */
export function buildMemoryToolSpecs(): MemoryToolSpecs {
  return {
    tools: MEMORY_TOOL_NAMES.map((name) => {
      const tool = MEMORY_TOOLS[name];
      const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input, {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>;
      return {
        name,
        description: tool.description,
        method: tool.method,
        path: tool.path,
        inputSchema,
      };
    }),
    limits: { renderedChars: MEMORY_LIMITS.rendered },
  };
}

const GENERATED_HEADER =
  "Generated from packages/shared/src/memory-tools.ts by `npm run generate:memory-tools -w @open-inspect/shared`. Do not edit.";
/** Repo-relative output paths for {@link formatMemoryToolSpecFiles}. */
export const MEMORY_TOOL_SPEC_FILES = {
  json: "packages/sandbox-runtime/src/sandbox_runtime/memory_tool_specs.json",
  module: "packages/sandbox-runtime/src/sandbox_runtime/tools/_memory-tool-specs.js",
} as const;

export function formatMemoryToolSpecFiles(): Record<keyof typeof MEMORY_TOOL_SPEC_FILES, string> {
  const specs = buildMemoryToolSpecs();
  const json = JSON.stringify(specs, null, 2);
  return {
    json: `${JSON.stringify({ $comment: GENERATED_HEADER, ...specs }, null, 2)}\n`,
    module: `// ${GENERATED_HEADER}\nexport const MEMORY_TOOL_SPECS = ${json};\n`,
  };
}
