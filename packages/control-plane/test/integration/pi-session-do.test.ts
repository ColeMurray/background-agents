import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { initSession, queryDO } from "./helpers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Workspace } from "@cloudflare/computer";
import { componentsOf, runInSessionDO } from "./session-do-access";
import type { SourceControlProvider } from "../../src/source-control";
import { PI_FEATURE_CAPABILITY_SNAPSHOT_KEY } from "../../src/pi/capability-snapshot";
import { WORKSPACE_QUOTA_STATE_KEY } from "../../src/pi/computer-workspace-quota";
import { SessionInternalPaths } from "../../src/session/contracts";

function piStub(name: string): DurableObjectStub<PiSessionDO> {
  if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
  return env.PI_SESSION.getByName(name);
}

function runInPiSessionDO<T>(
  stub: DurableObjectStub<PiSessionDO>,
  callback: (instance: PiSessionDO, state: DurableObjectState) => T | Promise<T>
): Promise<T> {
  return runInDurableObject(stub, (instance, state) => {
    if (!(instance instanceof PiSessionDO)) throw new Error("Expected PiSessionDO instance");
    return callback(instance, state);
  });
}

async function initializedPiStub(label: string) {
  const { sessionName } = await initSession({
    sessionName: `${label}-${crypto.randomUUID()}`,
    harness: "pi",
    model: "openai/gpt-5.6-sol",
    repoOwner: null,
    repoName: null,
    repoId: null,
  });
  return { sessionName, stub: piStub(sessionName) };
}

function workspaceOf(instance: PiSessionDO): Workspace {
  const workspace = (instance as unknown as { workspace?: Workspace }).workspace;
  if (!workspace) throw new Error("Expected initialized Computer Workspace");
  return workspace;
}

async function executeWorkspaceTool(
  instance: PiSessionDO,
  name: "read" | "ls" | "find" | "grep" | "write" | "edit" | "delete",
  args: Record<string, unknown>,
  callId: string
) {
  const root = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
  const tool = (await root.agent(BACKGROUND_CONTEXT)).tools.find(
    (candidate) => candidate.name === name
  );
  if (!tool) throw new Error(`Expected ${name} workspace tool`);
  return tool.execute(args, { callId } as ToolExecutionApi, BACKGROUND_CONTEXT);
}

describe("PiSessionDO", () => {
  it("creates a Pi SessionDO aggregate without any sandbox row", async () => {
    const { stub } = await initSession({
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });

    await expect(queryDO(stub, "SELECT id FROM sandbox")).resolves.toEqual([]);
  });

  it("opens Pi and Computer storage together and reports an idle root conversation", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-idle");
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
    );
    expect(tables.some((name) => name.startsWith("pi_"))).toBe(true);
    expect(tables.some((name) => name.startsWith("vfs_") || name.startsWith("_vfs_"))).toBe(true);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual({
      version: 1,
      capabilities: {
        workspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "enabled",
        externalActions: "enabled",
        mcp: "off",
      },
    });
  });

  it("initializes idempotently for the same Open-Inspect session", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-repeat");
    await stub.status(sessionName);
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
  });

  it("reads durable scratch files through the confined Computer adapter", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-read");
    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, async (instance) => {
      const workspace = workspaceOf(instance);
      await workspace.fs.writeFile("/workspace/scratch/note.txt", "durable note");
      return executeWorkspaceTool(instance, "read", { path: "note.txt" }, "integration-read");
    });

    expect(result).toMatchObject({
      isError: false,
      output: [expect.objectContaining({ type: "text", text: "durable note" })],
    });
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
    await expect(
      runInPiSessionDO(stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/scratch/note.txt", "utf8")
      )
    ).resolves.toBe("durable note");
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.get(WORKSPACE_QUOTA_STATE_KEY))
    ).resolves.toEqual({ bytes: 12, entries: 1, dirty: false });
  });

  it("writes, edits, and deletes scratch files through unsafe workspace tools", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-mutate");
    await stub.status(sessionName);

    const results = await runInPiSessionDO(stub, async (instance) => {
      const write = await executeWorkspaceTool(
        instance,
        "write",
        { path: "draft.txt", content: "hello world" },
        "integration-write"
      );
      const edit = await executeWorkspaceTool(
        instance,
        "edit",
        { path: "draft.txt", edits: [{ oldText: "world", newText: "Pi" }] },
        "integration-edit"
      );
      const text = await workspaceOf(instance).fs.readFile("/workspace/scratch/draft.txt", "utf8");
      const remove = await executeWorkspaceTool(
        instance,
        "delete",
        { path: "draft.txt" },
        "integration-delete"
      );
      return { write, edit, text, remove };
    });

    expect(results.write).toMatchObject({ isError: false });
    expect(results.edit).toMatchObject({ isError: false });
    expect(results.text).toBe("hello Pi");
    expect(results.remove).toMatchObject({ isError: false });
  });

  it("recovers dirty quota accounting after eviction and keeps the workspace root", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-recover");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, (instance) =>
      workspaceOf(instance).fs.writeFile("/workspace/scratch/kept.txt", "kept")
    );
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put(WORKSPACE_QUOTA_STATE_KEY, {
        bytes: 999_999,
        entries: 999,
        dirty: true,
      })
    );

    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: force Pi eviction"))
    ).rejects.toThrow();
    const restored = piStub(sessionName);
    await expect(restored.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });

    const rootDeletes = await runInPiSessionDO(restored, (instance) =>
      Promise.all(
        ["/workspace", "/workspace/scratch"].map((path, index) =>
          executeWorkspaceTool(
            instance,
            "delete",
            { path, recursive: true },
            `integration-delete-root-${index}`
          )
        )
      )
    );
    expect(rootDeletes).toEqual([
      expect.objectContaining({ isError: true }),
      expect.objectContaining({ isError: true }),
    ]);
    await expect(
      runInPiSessionDO(restored, (instance) =>
        workspaceOf(instance).fs.writeFile("/workspace/scratch/new.txt", "new")
      )
    ).resolves.toBeUndefined();
    await expect(
      runInDurableObject(restored, (_instance, state) =>
        state.storage.get(WORKSPACE_QUOTA_STATE_KEY)
      )
    ).resolves.toEqual({ bytes: 7, entries: 2, dirty: false });
    await expect(
      runInPiSessionDO(restored, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/scratch/kept.txt", "utf8")
      )
    ).resolves.toBe("kept");
  });

  it("rejects workspace reads outside the configured root", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-root");
    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, async (instance) => {
      return executeWorkspaceTool(instance, "read", { path: "../outside.txt" }, "integration-root");
    });

    expect(result).toMatchObject({ isError: true });
  });

  it("rejects every workspace tool at a symlink escape", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-workspace-symlink");
    await stub.status(sessionName);

    const results = await runInPiSessionDO(stub, async (instance) => {
      const workspace = workspaceOf(instance);
      await workspace.fs.symlink("/outside-secret.txt", "/workspace/scratch/escape");
      return Promise.all([
        executeWorkspaceTool(instance, "read", { path: "escape" }, "symlink-read"),
        executeWorkspaceTool(instance, "ls", { path: "escape" }, "symlink-ls"),
        executeWorkspaceTool(instance, "find", { path: "escape", pattern: "**/*" }, "symlink-find"),
        executeWorkspaceTool(
          instance,
          "grep",
          { path: "escape", query: "visible" },
          "symlink-grep"
        ),
      ]);
    });

    expect(results).toHaveLength(4);
    expect(results.every((result) => result.isError === true)).toBe(true);
  });

  it("isolates identical workspace paths between Pi sessions", async () => {
    const first = await initializedPiStub("pi-workspace-isolation-a");
    const second = await initializedPiStub("pi-workspace-isolation-b");
    await Promise.all([
      first.stub.status(first.sessionName),
      second.stub.status(second.sessionName),
    ]);

    await Promise.all([
      runInPiSessionDO(first.stub, (instance) =>
        workspaceOf(instance).fs.writeFile("/workspace/scratch/same.txt", "first")
      ),
      runInPiSessionDO(second.stub, (instance) =>
        workspaceOf(instance).fs.writeFile("/workspace/scratch/same.txt", "second")
      ),
    ]);

    const [firstText, secondText] = await Promise.all([
      runInPiSessionDO(first.stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/scratch/same.txt", "utf8")
      ),
      runInPiSessionDO(second.stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/scratch/same.txt", "utf8")
      ),
    ]);
    expect(firstText).toBe("first");
    expect(secondText).toBe("second");
  });

  it("returns a definite rejection when initialization fails before Pi admission", async () => {
    const sessionId = `missing-${crypto.randomUUID()}`;
    const stub = piStub(sessionId);

    await expect(
      stub.submit({
        sessionId,
        messageId: "message-1",
        content: "hello",
        model: "openai/gpt-5.6-sol",
      })
    ).resolves.toEqual({
      operationId: "message-1",
      accepted: false,
      rejected: "Pi Durable initialization failed",
    });

    const jobTables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_jobs'"
        )
        .toArray()
    );
    expect(jobTables).toEqual([]);
    const vfsTables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'vfs_%' OR name LIKE '_vfs_%' OR name LIKE 'computer_%')"
        )
        .toArray()
    );
    expect(vfsTables).toEqual([]);
  });

  it("installs repository and subagent extensions for a repository-backed session", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "develop",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "src/app.ts",
              type: "file",
              blobId: "blob-app",
              mode: "100644",
              sizeBytes: 18,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob: async () => new TextEncoder().encode("export const x=1;\n"),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);

    const agent = await runInPiSessionDO(stub, async (instance) => {
      const pi = await instance.harness.pi();
      const root = await pi.root(BACKGROUND_CONTEXT);
      const selected = await root.agent(BACKGROUND_CONTEXT);
      return {
        tools: selected.tools.map((tool) => tool.name),
        extensions: selected.extensions.map(({ name }) => name),
      };
    });
    expect(agent.tools).toEqual([
      "repository_list",
      "repository_read",
      "subagent",
      "read",
      "ls",
      "find",
      "grep",
      "write",
      "edit",
      "delete",
    ]);
    expect(agent.extensions).toEqual([
      "open-inspect.tool-policy",
      "open-inspect",
      "open-inspect.subagent",
      "open-inspect.workspace",
      "open-inspect.repository-overlay",
      "open-inspect.external-actions",
    ]);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual({
      version: 1,
      capabilities: {
        workspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "enabled",
        externalActions: "enabled",
        mcp: "off",
      },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("open-inspect:repository-pins")
      )
    ).resolves.toEqual([
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        commitSha: "a".repeat(40),
      },
    ]);
  });

  it("publishes guarded repository mutations through the SessionDiff service", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-edit-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "src/app.ts",
              type: "file",
              blobId: "blob-app",
              mode: "100644",
              sizeBytes: 18,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob: async () => new TextEncoder().encode("export const x=1;\n"),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, (instance) =>
      executeWorkspaceTool(
        instance,
        "write",
        { path: "/workspace/repos/0/src/app.ts", content: "export const x=2;\n" },
        "integration-write"
      )
    );

    expect(result).toMatchObject({ isError: false });
    const rows = await queryDO<{ bundle_json: string }>(
      sessionStub,
      "SELECT bundle_json FROM session_diff WHERE singleton = 1"
    );
    expect(JSON.parse(rows[0]?.bundle_json ?? "null")).toMatchObject({
      repositories: [
        {
          baseSha: "a".repeat(40),
          files: [expect.objectContaining({ path: "src/app.ts", status: "modified" })],
        },
      ],
    });

    const retry = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.diffRetry}`, { method: "POST" })
    );
    expect(retry.status).toBe(202);
  });

  it("deletes an evicted repository workspace without rematerializing provider data", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-delete-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({ entries: [], truncated: false }),
        readBlob: async () => new Uint8Array(),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: evict repository Pi"))
    ).rejects.toThrow();
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => {
          throw new Error("repository access revoked");
        },
        listTree: async () => {
          throw new Error("repository access revoked");
        },
        readBlob: async () => {
          throw new Error("repository access revoked");
        },
      } as unknown as SourceControlProvider;
    });

    await expect(piStub(sessionName).destroy(sessionName)).resolves.toBeUndefined();
  });

  it("restores a complete repository workspace after eviction without provider access", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-restore-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    const readBlob = vi.fn(async () => new TextEncoder().encode("durable\n"));
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "durable.txt",
              type: "file",
              blobId: "blob-durable",
              mode: "100644",
              sizeBytes: 8,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob,
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);
    expect(readBlob).toHaveBeenCalledOnce();
    await expect(
      runInPiSessionDO(stub, (_instance, state) => state.abort("test: evict repository Pi"))
    ).rejects.toThrow();
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => {
          throw new Error("repository access revoked");
        },
        listTree: async () => {
          throw new Error("repository access revoked");
        },
        readBlob: async () => {
          throw new Error("repository access revoked");
        },
      } as unknown as SourceControlProvider;
    });

    await expect(piStub(sessionName).status(sessionName)).resolves.toMatchObject({ busy: false });
    const result = await runInPiSessionDO(piStub(sessionName), (instance) =>
      executeWorkspaceTool(
        instance,
        "read",
        { path: "/workspace/repos/0/durable.txt" },
        "read-restored"
      )
    );
    expect(result).toMatchObject({ isError: false });
  });

  it("rejects invalid UTF-8 provider bytes before mutating the real Computer VFS", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-binary-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: [
            {
              path: "invalid.bin",
              type: "file",
              blobId: "blob-invalid",
              mode: "100644",
              sizeBytes: 1,
              executable: false,
            },
          ],
          truncated: false,
        }),
        readBlob: async () => new Uint8Array([0xff]),
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);
    await stub.status(sessionName);

    await expect(
      runInPiSessionDO(stub, (instance) =>
        executeWorkspaceTool(
          instance,
          "write",
          { path: "/workspace/repos/0/invalid.bin", content: "replacement\n" },
          "integration-invalid-utf8"
        )
      )
    ).rejects.toThrow("UTF-8 text");
    const bytes = await runInPiSessionDO(stub, async (instance) => {
      const stream = await workspaceOf(instance).fs.readFile("/workspace/repos/0/invalid.bin");
      const reader = stream.getReader();
      const chunk = await reader.read();
      return chunk.value;
    });
    expect(bytes).toEqual(new Uint8Array([0xff]));
  });

  it("materializes 51 provider files through bounded SessionDO batches", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-batches-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    const readBlob = vi.fn(async () => new TextEncoder().encode("x"));
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit: async () => ({ sha: "a".repeat(40) }),
        listTree: async () => ({
          entries: Array.from({ length: 51 }, (_, index) => ({
            path: `file-${index}.txt`,
            type: "file",
            blobId: `blob-${index}`,
            mode: "100644",
            sizeBytes: 1,
            executable: false,
          })),
          truncated: false,
        }),
        readBlob,
      } as unknown as SourceControlProvider;
    });
    const stub = piStub(sessionName);

    await stub.status(sessionName);

    const result = await runInPiSessionDO(stub, (instance) =>
      executeWorkspaceTool(instance, "read", { path: "/workspace/repos/0/file-50.txt" }, "read-51")
    );
    expect(result).toMatchObject({ isError: false });
    expect(readBlob).toHaveBeenCalledTimes(51);
  });

  it("recovers a claimed baseline when Pi crashes before persisting its pins", async () => {
    const { sessionName, stub: sessionStub } = await initSession({
      sessionName: `pi-repository-pin-crash-${crypto.randomUUID()}`,
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: "acme",
      repoName: "widgets",
      repoId: 123,
      defaultBranch: "main",
    });
    const firstSha = "a".repeat(40);
    const movedSha = "b".repeat(40);
    const resolveCommit = vi.fn(async () => ({ sha: firstSha }));
    await runInSessionDO(sessionStub, (instance) => {
      componentsOf(instance).sourceControlProvider = {
        name: "github",
        resolveCommit,
        listTree: async () => ({ entries: [], truncated: false }),
        readBlob: async () => new Uint8Array(),
      } as unknown as SourceControlProvider;
    });
    const claimed = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.piContext}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(claimed.status).toBe(200);
    resolveCommit.mockResolvedValue({ sha: movedSha });

    const stub = piStub(sessionName);
    await stub.status(sessionName);

    expect(resolveCommit).toHaveBeenCalledOnce();
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("open-inspect:repository-pins")
      )
    ).resolves.toEqual([
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        commitSha: firstSha,
      },
    ]);
  });

  it("clears Pi transcript and lifecycle storage when the session is deleted", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-delete");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, (instance) =>
      workspaceOf(instance).fs.writeFile("/workspace/scratch/delete-me.txt", "gone")
    );

    await stub.destroy(sessionName);
    await stub.destroy(sessionName);

    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
        )
        .toArray()
        .map((row) => row.name)
    );
    expect(tables.some((name) => name.startsWith("pi_"))).toBe(false);
    expect(
      tables.some(
        (name) =>
          name.startsWith("vfs_") || name.startsWith("_vfs_") || name.startsWith("computer_")
      )
    ).toBe(false);
  });

  it("deletes a cold Pi object before its harness has opened", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-delete-cold");

    await expect(stub.destroy(sessionName)).resolves.toBeUndefined();

    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
        )
        .toArray()
        .map((row) => row.name)
    );
    expect(tables.some((name) => name.startsWith("pi_"))).toBe(false);
    expect(
      tables.some(
        (name) =>
          name.startsWith("vfs_") || name.startsWith("_vfs_") || name.startsWith("computer_")
      )
    ).toBe(false);
  });

  it("preserves the first projection baseline when scheduling the same operation again", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-projection");
    await stub.status(sessionName);

    await runInPiSessionDO(stub, async (instance) => {
      await instance.projector.schedule({
        sessionId: sessionName,
        operationId: "message-1",
        usageBaseline: {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          total: 10,
        },
      });
      await instance.projector.schedule({
        sessionId: sessionName,
        operationId: "message-1",
        usageBaseline: {
          input: 100,
          output: 200,
          cacheRead: 300,
          cacheWrite: 400,
          total: 1_000,
        },
      });
    });

    const jobs = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM cf_agents_jobs WHERE capability = 'pi-projection' AND id = 'message-1'"
        )
        .toArray()
    );
    expect(JSON.parse(jobs[0]?.payload ?? "null")).toMatchObject({
      usageBaseline: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    });
  });

  it("permanently disables lifecycle alarms before deleting the Pi object", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-delete-alarm");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, async (instance) => {
      await instance.projector.schedule({
        sessionId: sessionName,
        operationId: "message-1",
        usageBaseline: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      });
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    ).resolves.not.toBeNull();

    await stub.destroy(sessionName);

    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    ).resolves.toBeNull();
  });
});
