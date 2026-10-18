import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { initSession, queryDO } from "./helpers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Workspace } from "@cloudflare/computer";
import { componentsOf, runInSessionDO } from "./session-do-access";
import type { SourceControlProvider } from "../../src/source-control";
import { PI_FEATURE_CAPABILITY_SNAPSHOT_KEY } from "../../src/pi/capability-snapshot";

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
  name: "read" | "ls" | "find" | "grep",
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
      await workspace.fs.writeFile("/workspace/note.txt", "durable note");
      return executeWorkspaceTool(instance, "read", { path: "note.txt" }, "integration-read");
    });

    expect(result).toMatchObject({
      isError: false,
      output: [expect.objectContaining({ type: "text", text: "durable note" })],
    });
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
    await expect(
      runInPiSessionDO(stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/note.txt", "utf8")
      )
    ).resolves.toBe("durable note");
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
      await workspace.fs.writeFile("/outside-secret.txt", "not visible");
      await workspace.fs.symlink("/outside-secret.txt", "/workspace/escape");
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
        workspaceOf(instance).fs.writeFile("/workspace/same.txt", "first")
      ),
      runInPiSessionDO(second.stub, (instance) =>
        workspaceOf(instance).fs.writeFile("/workspace/same.txt", "second")
      ),
    ]);

    const [firstText, secondText] = await Promise.all([
      runInPiSessionDO(first.stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/same.txt", "utf8")
      ),
      runInPiSessionDO(second.stub, (instance) =>
        workspaceOf(instance).fs.readFile("/workspace/same.txt", "utf8")
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
        resolveCommit: async () => ({ sha: "abc123" }),
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
    ]);
    expect(agent.extensions).toEqual([
      "open-inspect.tool-policy",
      "open-inspect",
      "open-inspect.subagent",
      "open-inspect.workspace",
    ]);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
      )
    ).resolves.toEqual({
      version: 1,
      capabilities: {
        workspace: "read_only",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
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
        commitSha: "abc123",
      },
    ]);
  });

  it("clears Pi transcript and lifecycle storage when the session is deleted", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-delete");
    await stub.status(sessionName);
    await runInPiSessionDO(stub, (instance) =>
      workspaceOf(instance).fs.writeFile("/workspace/delete-me.txt", "gone")
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
