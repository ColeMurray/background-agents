import type { Message } from "@earendil-works/pi-ai";
import type { Extension, GenerationHooks } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import {
  buildMemorySandboxContract,
  harnessMemoryToolName,
} from "@open-inspect/shared/memory-tools";
import {
  createMemoryExtension,
  memoryReadParameters,
  memorySearchParameters,
  memoryWriteParameters,
  PI_MEMORY_TOOL_NAMES,
} from "./memory-extension";

/**
 * The comparable shape of one JSON Schema.
 *
 * The shared contract renders an enum as `type` + `enum`; the Pi registry
 * renders the same values as a union of literals. Both are the same schema,
 * so both are reduced to one comparable form before they are compared.
 */
interface ComparableProperty {
  type?: string;
  values?: unknown[];
  [key: string]: unknown;
}

function schemaType(property: Record<string, unknown>): string | undefined {
  if (typeof property.type === "string") return property.type;
  const anyOf = property.anyOf;
  if (!Array.isArray(anyOf) || !anyOf.length) return undefined;
  const types = new Set(
    anyOf.map((entry) => (entry as { type?: string }).type).filter((type): type is string => !!type)
  );
  return types.size === 1 ? [...types][0] : undefined;
}

function comparable(schema: unknown): {
  properties: Record<string, ComparableProperty>;
  required: string[];
  additionalProperties: unknown;
} {
  const raw = JSON.parse(JSON.stringify(schema)) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties?: unknown;
  };
  const properties: Record<string, ComparableProperty> = {};
  for (const [name, property] of Object.entries(raw.properties ?? {})) {
    const { anyOf, enum: enumValues, const: constValue, ...rest } = property;
    const values: unknown[] | undefined = Array.isArray(enumValues)
      ? enumValues
      : Array.isArray(anyOf)
        ? anyOf.map((entry) => (entry as { const?: unknown }).const)
        : constValue !== undefined
          ? [constValue]
          : undefined;
    properties[name] = {
      ...rest,
      type: schemaType(property),
      ...(values === undefined ? {} : { values }),
    };
  }
  return {
    properties,
    required: [...(raw.required ?? [])].sort(),
    additionalProperties: raw.additionalProperties,
  };
}

const contract = buildMemorySandboxContract();
const contractSchema = (name: string) =>
  comparable(contract.tools.find((tool) => tool.name === name)?.inputSchema);

function beforeRequest(extension: Extension): GenerationHooks["beforeRequest"] {
  const registration = extension.hooks?.[0] as { handlers?: Partial<GenerationHooks> } | undefined;
  const handler = registration?.handlers?.beforeRequest;
  if (!handler) throw new Error("The extension contributes no generation hook");
  return handler;
}

const noRenderedMemory = async () => null;

describe("memory extension", () => {
  it("exposes the shared contract's canonical names and descriptions", () => {
    expect(PI_MEMORY_TOOL_NAMES).toEqual({
      read: harnessMemoryToolName("pi", "memory_read"),
      write: harnessMemoryToolName("pi", "memory_write"),
      search: harnessMemoryToolName("pi", "memory_search"),
    });
    const extension = createMemoryExtension({
      client: {
        read: async () => ({ id: "mem_1", status: "archived" }) as never,
        write: async () => ({ id: "mem_1", status: "active", revisionId: "mrev_1" }),
        search: async () => ({ results: [], hasMore: false }),
      },
      currentMemory: noRenderedMemory,
      mode: "enabled",
    });
    for (const tool of extension.tools ?? []) {
      const contractTool = contract.tools.find((candidate) => candidate.name === tool.name);
      expect(contractTool).toBeDefined();
      expect(tool.description).toBe(contractTool?.description);
    }
  });

  it("keeps the read arguments the shared contract declares", () => {
    expect(comparable(memoryReadParameters)).toEqual(contractSchema("memory_read"));
  });

  it("keeps the write arguments the shared contract declares", () => {
    expect(comparable(memoryWriteParameters)).toEqual(contractSchema("memory_write"));
  });

  it("keeps the search arguments the shared contract declares", () => {
    expect(comparable(memorySearchParameters)).toEqual(contractSchema("memory_search"));
  });

  it("reads through the owning session and returns the record", async () => {
    const read = vi.fn(async () => ({
      id: "mem_1",
      status: "active" as const,
      memoryType: "fact" as const,
      scope: { type: "personal" as const },
      title: "Deploy window",
      description: "Deploys happen on Tuesdays",
      content: "Tuesdays only",
      revisionId: "mrev_1",
      revisionNumber: 1,
      authorKind: "user" as const,
      authorUserId: "user_1",
      authorSessionId: null,
    }));
    const extension = createMemoryExtension({
      client: {
        read,
        write: async () => ({ id: "mem_1", status: "active", revisionId: "mrev_1" }),
        search: async () => ({ results: [], hasMore: false }),
      },
      currentMemory: noRenderedMemory,
      mode: "enabled",
    });
    const tool = extension.tools?.find((candidate) => candidate.name === PI_MEMORY_TOOL_NAMES.read);
    if (!tool) throw new Error("The extension contributes no read tool");

    const output = await tool.execute(
      { memoryId: "mem_1" },
      {} as never,
      { abortSignal: undefined } as never
    );

    expect(read).toHaveBeenCalledWith({ memoryId: "mem_1" }, undefined);
    expect(output.isError).toBe(false);
    expect(JSON.stringify(output.output)).toContain("Tuesdays only");
    expect(output.details).toMatchObject({ id: "mem_1", status: "active" });
  });

  it("states that a shared write is a proposal awaiting a person", async () => {
    const extension = createMemoryExtension({
      client: {
        read: async () => ({ id: "mem_1", status: "archived" }) as never,
        write: async () => ({ id: "mem_1", status: "proposed", revisionId: "mrev_1" }),
        search: async () => ({ results: [], hasMore: false }),
      },
      currentMemory: noRenderedMemory,
      mode: "enabled",
    });
    const tool = extension.tools?.find(
      (candidate) => candidate.name === PI_MEMORY_TOOL_NAMES.write
    );
    if (!tool) throw new Error("The extension contributes no write tool");

    const output = await tool.execute(
      {
        memoryType: "fact",
        title: "Deploy window",
        description: "Deploys happen on Tuesdays",
        content: "Tuesdays only",
        scopeType: "repository",
      },
      {} as never,
      { abortSignal: undefined } as never
    );

    expect(output.isError).toBe(false);
    expect(JSON.stringify(output.output)).toContain("approval");
    expect(output.details).toMatchObject({ id: "mem_1", status: "proposed" });
  });

  it("withholds the write from a read-only capability", () => {
    const extension = createMemoryExtension({
      client: {
        read: async () => ({ id: "mem_1", status: "archived" }) as never,
        write: async () => ({ id: "mem_1", status: "active", revisionId: "mrev_1" }),
        search: async () => ({ results: [], hasMore: false }),
      },
      currentMemory: noRenderedMemory,
      mode: "read_only",
    });

    expect((extension.tools ?? []).map((tool) => tool.name)).toEqual([
      PI_MEMORY_TOOL_NAMES.read,
      PI_MEMORY_TOOL_NAMES.search,
    ]);
  });

  it("refetches rendered memory before every model request", async () => {
    const currentMemory = vi
      .fn()
      .mockResolvedValueOnce({ rendered: "# Current memory A" })
      .mockResolvedValueOnce({ rendered: "# Current memory B" });
    const extension = createMemoryExtension({
      client: {
        read: async () => ({ id: "mem_1", status: "archived" }) as never,
        write: async () => ({ id: "mem_1", status: "active", revisionId: "mrev_1" }),
        search: async () => ({ results: [], hasMore: false }),
      },
      currentMemory,
      mode: "enabled",
    });
    const messages: Message[] = [
      {
        role: "system",
        content: "Base prompt",
        sections: { memory: "# Stale memory" },
        timestamp: 1,
      },
      { role: "user", content: "Continue", timestamp: 2 },
    ];
    const hook = beforeRequest(extension);

    const first = await hook({ messages }, {} as never, { abortSignal: undefined } as never);
    const second = await hook(
      { messages: first?.messages ?? messages },
      {} as never,
      { abortSignal: undefined } as never
    );

    expect(currentMemory).toHaveBeenCalledTimes(2);
    expect(first?.messages.at(-1)).toMatchObject({
      role: "system",
      sections: { memory: "# Current memory A" },
    });
    expect(second?.messages.at(-1)).toMatchObject({
      role: "system",
      sections: { memory: "# Current memory B" },
    });
  });

  it("fails closed instead of reusing rendered memory when refresh fails", async () => {
    const extension = createMemoryExtension({
      client: {
        read: async () => ({ id: "mem_1", status: "archived" }) as never,
        write: async () => ({ id: "mem_1", status: "active", revisionId: "mrev_1" }),
        search: async () => ({ results: [], hasMore: false }),
      },
      currentMemory: async () => {
        throw new Error("current author unavailable");
      },
      mode: "enabled",
    });
    const messages: Message[] = [
      {
        role: "system",
        content: "Base prompt",
        sections: { memory: "# Stale memory" },
        timestamp: 1,
      },
    ];

    await expect(
      beforeRequest(extension)({ messages }, {} as never, { abortSignal: undefined } as never)
    ).rejects.toThrow("current author unavailable");
  });
});
