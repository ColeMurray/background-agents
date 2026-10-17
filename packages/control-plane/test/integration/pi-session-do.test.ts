import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { initSession, queryDO } from "./helpers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { componentsOf, runInSessionDO } from "./session-do-access";
import type { SourceControlProvider } from "../../src/source-control";

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

  it("opens Pi's prefixed SQLite store and reports an idle root conversation", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-idle");
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
  });

  it("initializes idempotently for the same Open-Inspect session", async () => {
    const { sessionName, stub } = await initializedPiStub("pi-repeat");
    await stub.status(sessionName);
    await expect(stub.status(sessionName)).resolves.toEqual({ busy: false, pending: 0 });
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

    const tools = await runInPiSessionDO(stub, async (instance) => {
      const pi = await instance.harness.pi();
      const root = await pi.root(BACKGROUND_CONTEXT);
      return (await root.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    });
    expect(tools).toEqual(["repository_list", "repository_read", "subagent"]);
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
