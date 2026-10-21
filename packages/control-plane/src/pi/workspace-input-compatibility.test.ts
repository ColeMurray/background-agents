import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { createComputerWorkspaceCapability } from "./computer-workspace-extension";
import type { WorkspaceToolFacade } from "../pi/computer-workspace-quota";

function realComputerTools() {
  const files = new Map<string, Uint8Array>();
  const grep = vi.fn(async () => []);
  const fs = {
    async stat(path: string) {
      const bytes = files.get(path);
      if (!bytes) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        size: bytes.byteLength,
        mtime: 0,
        mode: 0o100644,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      };
    },
    async lstat(path: string) {
      return this.stat(path);
    },
    async readFile(path: string) {
      const bytes = files.get(path);
      if (!bytes) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async writeFile(path: string, bytes: Uint8Array) {
      files.set(path, new Uint8Array(bytes));
    },
    async mkdir() {},
    async rm(path: string) {
      files.delete(path);
    },
    async readdir() {
      return [];
    },
    async find() {
      return [];
    },
    grep,
  };
  const extension = createComputerWorkspaceCapability(
    { fs } as unknown as WorkspaceToolFacade,
    "enabled"
  ).extension;
  return { extension, files, grep };
}

async function executePrepared(
  tools: ReturnType<typeof realComputerTools>,
  name: string,
  raw: Record<string, unknown>
) {
  const tool = tools.extension.tools?.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  const prepared = tool.prepareArguments?.(raw) ?? raw;
  const call = { type: "toolCall", id: `${name}-compat`, name, arguments: prepared };
  const validated = validateToolArguments(tool as never, call as never) as Record<string, unknown>;
  return tool.execute(validated, { callId: call.id } as ToolExecutionApi, {
    abortSignal: new AbortController().signal,
    value: () => undefined,
    toString: () => "test",
  });
}

describe("workspace input compatibility with Computer 0.5.1", () => {
  it("preserves optional-null normalization before strict dispatch validation", async () => {
    const tools = realComputerTools();
    const raw = {
      path: ".",
      query: "needle",
      include: null,
      exclude: null,
      regex: null,
      ignoreCase: null,
      context: null,
      limit: null,
      offset: null,
    };

    const result = await executePrepared(tools, "grep", raw);

    expect(result.isError).toBe(false);
    expect(tools.grep).toHaveBeenCalledWith("needle", "/workspace/scratch", {
      regex: false,
      ignoreCase: false,
      context: 0,
      include: undefined,
      exclude: undefined,
      limit: 201,
      offset: 0,
    });
  });

  it.each([
    {
      label: "root legacy fields",
      args: { path: "note.txt", oldText: "old", newText: "new", edits: null },
    },
    {
      label: "JSON-packed edits",
      args: { path: "note.txt", edits: JSON.stringify([{ oldText: "old", newText: "new" }]) },
    },
    {
      label: "malformed packed edits with valid root fallback",
      args: { path: "note.txt", edits: "{", oldText: "old", newText: "new" },
    },
  ])("preserves Computer's $label repair", async ({ args }) => {
    const tools = realComputerTools();
    tools.files.set("/workspace/scratch/note.txt", new TextEncoder().encode("old value\n"));

    const result = await executePrepared(tools, "edit", args);

    expect(result.isError).toBe(false);
    expect(new TextDecoder().decode(tools.files.get("/workspace/scratch/note.txt"))).toBe(
      "new value\n"
    );
  });

  it.each([
    {
      label: "edit count",
      name: "edit",
      args: {
        path: "note.txt",
        edits: Array.from({ length: 101 }, () => ({ oldText: "a", newText: "b" })),
      },
    },
    {
      label: "edit cumulative bytes",
      name: "edit",
      args: { path: "note.txt", edits: [{ oldText: "a".repeat(2 * 1024 * 1024), newText: "b" }] },
    },
    {
      label: "glob array",
      name: "find",
      args: { path: ".", pattern: "**/*", exclude: Array.from({ length: 33 }, () => "x") },
    },
    {
      label: "query bytes",
      name: "grep",
      args: { path: ".", query: "x".repeat(16 * 1024 + 1) },
    },
    {
      label: "offset",
      name: "grep",
      args: { path: ".", query: "x", offset: 1_000_001 },
    },
  ])(
    "rejects oversized canonical $label before Pi schema traversal or execution",
    ({ name, args }) => {
      const tools = realComputerTools();
      const tool = tools.extension.tools?.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing ${name}`);

      expect(() => tool.prepareArguments?.(args)).toThrow();
      expect(tools.grep).not.toHaveBeenCalled();
      expect(tools.files.size).toBe(0);
    }
  );
});
