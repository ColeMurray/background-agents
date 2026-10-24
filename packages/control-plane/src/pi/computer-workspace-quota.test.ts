import { describe, expect, it } from "vitest";
import type {
  Workspace,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeResult,
} from "@cloudflare/computer";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import {
  WORKSPACE_QUOTA_STATE_KEY,
  WorkspaceMutationFifo,
  createCoordinatedWorkspaceToolFacade,
  createLazyWorkspaceToolFacade,
  createQuotaWorkspace,
  createWorkspaceToolFacade,
} from "../pi/computer-workspace-quota";
import type { WorkspaceToolFacade } from "../pi/computer-workspace-quota";

interface FileEntry {
  content?: Uint8Array;
  directory?: true;
  symbolicLink?: true;
}

class MemoryStorage {
  values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class RollbackQueueDatabase implements SqliteDatabase {
  records: string[] = [];
  private tail: Promise<void> = Promise.resolve();

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const snapshot = [...this.records];
      try {
        return await callback(this);
      } catch (error) {
        this.records = snapshot;
        throw error;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async exec(_sql: string): Promise<void> {}
  async run(_sql: string, ..._params: SqliteValue[]): Promise<void> {}
  async get<T extends object>(_sql: string, ..._params: SqliteValue[]): Promise<T | undefined> {
    return undefined;
  }
  async all<T extends object>(_sql: string, ..._params: SqliteValue[]): Promise<T[]> {
    return [];
  }
  async close(): Promise<void> {}
}

function runtimeHandle(
  events: ReadableStream<WorkspaceRuntimeEvent<"utf8">>,
  result: () => Promise<WorkspaceRuntimeResult<"utf8">>,
  kill: (signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP") => Promise<void> = async () => {}
): WorkspaceRuntimeExecHandle<"utf8"> {
  Object.defineProperties(events, {
    id: { value: "exec-1" },
    backend: { value: "worker-javascript" },
    result: { value: result },
    kill: { value: kill },
    [Symbol.dispose]: { value: () => void events.cancel() },
  });
  return events as WorkspaceRuntimeExecHandle<"utf8">;
}

function coordinatedRuntime(
  database: SqliteDatabase,
  exec: () => Promise<WorkspaceRuntimeExecHandle<"utf8">>
) {
  const workspace = {
    fs: {},
    runtime: {
      exec,
      backends: () => [],
    },
  } as unknown as WorkspaceToolFacade;
  return createCoordinatedWorkspaceToolFacade(workspace, database).runtime!;
}

async function allowQueuedTransactionToStart(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function memoryWorkspace(seed: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  const files = new Map<string, FileEntry>([
    ["/workspace", { directory: true }],
    ["/workspace/scratch", { directory: true }],
  ]);
  const readdirCalls: Array<{ path: string; limit?: number; offset?: number }> = [];
  for (const [path, content] of Object.entries(seed)) {
    files.set(path, { content: encoder.encode(content) });
  }
  const normalize = (path: string) => path.replace(/\/+$/, "") || "/";
  const failures = { nextWrite: false };
  let revision = 0;
  const fs = {
    async readFile(path: string) {
      const entry = files.get(normalize(path));
      if (!entry?.content) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(entry.content);
          controller.close();
        },
      });
    },
    async stat(path: string) {
      const entry = files.get(normalize(path));
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        name: path.split("/").at(-1) ?? "",
        mode: 0o644,
        mtime: 0,
        size: entry.content?.byteLength ?? 0,
        isFile: entry.content !== undefined,
        isDirectory: entry.directory === true,
        isSymbolicLink: entry.symbolicLink === true,
      };
    },
    async lstat(path: string) {
      return this.stat(path);
    },
    async writeFile(path: string, content: Uint8Array) {
      if (failures.nextWrite) {
        failures.nextWrite = false;
        throw new Error("write failed");
      }
      files.set(normalize(path), { content: new Uint8Array(content) });
      revision += 1;
    },
    async mkdir(path: string, options?: { recursive?: boolean }) {
      const normalized = normalize(path);
      if (options?.recursive) {
        let current = "";
        for (const segment of normalized.split("/").filter(Boolean)) {
          current += `/${segment}`;
          if (!files.has(current)) {
            files.set(current, { directory: true });
            revision += 1;
          }
        }
        return;
      }
      files.set(normalized, { directory: true });
      revision += 1;
    },
    async rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
      const target = normalize(path);
      if (!files.has(target) && options?.force) return;
      for (const candidate of [...files.keys()]) {
        if (candidate === target || (options?.recursive && candidate.startsWith(`${target}/`))) {
          files.delete(candidate);
          revision += 1;
        }
      }
    },
    async readdir(path: string, options?: { limit?: number; offset?: number }) {
      readdirCalls.push({ path, ...options });
      const parent = normalize(path);
      const prefix = parent === "/" ? "/" : `${parent}/`;
      const direct = [...files.entries()]
        .filter(([candidate]) => candidate.startsWith(prefix))
        .filter(([candidate]) => !candidate.slice(prefix.length).includes("/"))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([candidate, entry]) => ({
          name: candidate.slice(prefix.length),
          size: entry.content?.byteLength ?? 0,
          mtime: 0,
          isFile: entry.content !== undefined,
          isDirectory: entry.directory === true,
          isSymbolicLink: false,
        }));
      const offset = options?.offset ?? 0;
      return direct.slice(offset, offset + (options?.limit ?? direct.length));
    },
    async find() {
      return [];
    },
    async grep() {
      return [];
    },
  };
  const workspace = {
    fs,
    db: {
      scalar(query: string) {
        if (!query.includes("vfs_meta")) throw new Error(`unexpected query: ${query}`);
        return revision;
      },
    },
    runtime: { exec: () => undefined },
    git: { status: () => undefined },
    assets: { publish: () => undefined },
    artifacts: { list: () => undefined },
    mounts: () => new Map(),
  } as unknown as Workspace;
  return { workspace, files, failures, readdirCalls, revision: () => revision };
}

describe("createQuotaWorkspace", () => {
  it("does not construct Computer until the first workspace method call", async () => {
    const { workspace } = memoryWorkspace({ "/workspace/scratch/note.txt": "hello" });
    let opens = 0;
    const lazy = createLazyWorkspaceToolFacade(async () => {
      opens += 1;
      return createWorkspaceToolFacade(workspace);
    });

    expect(opens).toBe(0);
    await lazy.fs.stat("/workspace/scratch/note.txt");
    await lazy.fs.stat("/workspace/scratch");
    expect(opens).toBe(1);
  });

  it("enforces one aggregate byte quota across files and overwrites", async () => {
    const storage = new MemoryStorage();
    const { workspace, files } = memoryWorkspace({ "/workspace/scratch/a.txt": "1234" });
    const bounded = createQuotaWorkspace(workspace, storage, 9, 2);

    await bounded.fs.writeFile("/workspace/scratch/b.txt", new TextEncoder().encode("1234"));
    await bounded.fs.writeFile("/workspace/scratch/a.txt", new TextEncoder().encode("12345"));
    await expect(
      bounded.fs.writeFile("/workspace/scratch/a.txt", new TextEncoder().encode("123456"))
    ).rejects.toThrow("quota");
    await expect(
      bounded.fs.writeFile("/workspace/scratch/c.txt", new Uint8Array())
    ).rejects.toThrow("entry quota");

    expect(new TextDecoder().decode(files.get("/workspace/scratch/a.txt")?.content)).toBe("12345");
    await expect(storage.get(WORKSPACE_QUOTA_STATE_KEY)).resolves.toMatchObject({
      version: 2,
      bytes: 9,
      entries: 2,
      dirty: false,
    });
  });

  it("recounts dirty durable accounting after the workspace proxy reopens", async () => {
    const storage = new MemoryStorage();
    const { workspace } = memoryWorkspace({ "/workspace/scratch/a.txt": "12" });
    const first = createQuotaWorkspace(workspace, storage, 8, 4);
    await first.fs.writeFile("/workspace/scratch/b.txt", new TextEncoder().encode("3"));
    storage.values.set(WORKSPACE_QUOTA_STATE_KEY, { bytes: 999, entries: 999, dirty: true });
    const reopened = createQuotaWorkspace(workspace, storage, 8, 4);

    await reopened.fs.writeFile("/workspace/scratch/c.txt", new TextEncoder().encode("4567"));

    await expect(storage.get(WORKSPACE_QUOTA_STATE_KEY)).resolves.toMatchObject({
      version: 2,
      bytes: 7,
      entries: 3,
      dirty: false,
    });
  });

  it("counts deep-write directories and allows overwrites at the entry cap", async () => {
    const storage = new MemoryStorage();
    const { workspace, files } = memoryWorkspace({ "/workspace/scratch/a.txt": "1" });
    const bounded = createQuotaWorkspace(workspace, storage, 8, 3);

    await bounded.fs.mkdir("/workspace/scratch/notes", { recursive: true });
    await bounded.fs.writeFile("/workspace/scratch/notes/new.txt", new TextEncoder().encode("x"));
    await bounded.fs.writeFile("/workspace/scratch/a.txt", new TextEncoder().encode("12"));
    await expect(
      bounded.fs.writeFile("/workspace/scratch/other.txt", new TextEncoder().encode("x"))
    ).rejects.toThrow("entry quota");

    expect(files.has("/workspace/scratch/notes")).toBe(true);
    expect(files.has("/workspace/scratch/notes/new.txt")).toBe(true);
    expect(files.has("/workspace/scratch/other.txt")).toBe(false);
    await expect(storage.get(WORKSPACE_QUOTA_STATE_KEY)).resolves.toMatchObject({
      version: 2,
      bytes: 3,
      entries: 3,
      dirty: false,
    });
  });

  it("does not claim future repository overlay roots", async () => {
    const storage = new MemoryStorage();
    const { workspace, files } = memoryWorkspace();
    const bounded = createQuotaWorkspace(workspace, storage, 8, 4);

    await expect(
      bounded.fs.writeFile("/workspace/repos/0/file.txt", new TextEncoder().encode("repo"))
    ).rejects.toThrow("outside /workspace/scratch");
    expect(files.has("/workspace/repos/0/file.txt")).toBe(false);
  });

  it("recovers malformed accounting and a failed filesystem write", async () => {
    const storage = new MemoryStorage();
    storage.values.set(WORKSPACE_QUOTA_STATE_KEY, {
      bytes: 100,
      entries: "invalid",
      dirty: false,
    });
    const { workspace, failures } = memoryWorkspace({ "/workspace/scratch/a.txt": "12" });
    const bounded = createQuotaWorkspace(workspace, storage, 8, 4);

    await bounded.fs.writeFile("/workspace/scratch/b.txt", new TextEncoder().encode("34"));
    failures.nextWrite = true;
    await expect(
      bounded.fs.writeFile("/workspace/scratch/a.txt", new TextEncoder().encode("x"))
    ).rejects.toThrow("write failed");

    await expect(storage.get(WORKSPACE_QUOTA_STATE_KEY)).resolves.toMatchObject({
      version: 2,
      bytes: 4,
      entries: 2,
      dirty: false,
    });
  });

  it("rebuilds accounting through bounded pages", async () => {
    const storage = new MemoryStorage();
    const seed = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [`/workspace/scratch/${index}.txt`, "x"])
    );
    const { workspace, readdirCalls } = memoryWorkspace(seed);
    const bounded = createQuotaWorkspace(workspace, storage, 2_000, 1_002);

    await bounded.fs.writeFile("/workspace/scratch/final.txt", new TextEncoder().encode("x"));

    await expect(storage.get(WORKSPACE_QUOTA_STATE_KEY)).resolves.toMatchObject({
      version: 2,
      bytes: 1_002,
      entries: 1_002,
      dirty: false,
    });
    expect(readdirCalls.slice(0, 2)).toEqual([
      { path: "/workspace/scratch", limit: 1_000, offset: 0 },
      { path: "/workspace/scratch", limit: 1_000, offset: 1_000 },
    ]);
  });

  it("cancels a streamed write as soon as it exceeds the remaining quota", async () => {
    const storage = new MemoryStorage();
    const { workspace } = memoryWorkspace();
    const bounded = createQuotaWorkspace(workspace, storage, 1, 1);
    let cancelled = false;
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(bounded.fs.writeFile("/workspace/scratch/large.bin", content)).rejects.toThrow(
      "quota"
    );
    expect(cancelled).toBe(true);
  });

  it("recounts after recursive deletion and refuses every spelling of the root", async () => {
    const storage = new MemoryStorage();
    const { workspace, files } = memoryWorkspace({
      "/workspace/scratch/a.txt": "1234",
      "/workspace/scratch/nested/b.txt": "12",
    });
    files.set("/workspace/scratch/nested", { directory: true });
    const bounded = createQuotaWorkspace(workspace, storage, 8);

    await bounded.fs.rm("/workspace/scratch/nested", { recursive: true, force: true });
    await expect(storage.get(WORKSPACE_QUOTA_STATE_KEY)).resolves.toMatchObject({
      version: 2,
      bytes: 4,
      entries: 1,
      dirty: false,
    });
    for (const path of [
      "/workspace",
      "/workspace/",
      "/workspace/.",
      "/workspace/child/..",
      "/workspace/scratch",
      "/workspace/scratch/",
      "/workspace/scratch/.",
      "/workspace/scratch/child/..",
      "child/..",
    ]) {
      await expect(bounded.fs.rm(path, { recursive: true })).rejects.toThrow("workspace root");
    }
    expect(files.has("/workspace/scratch/a.txt")).toBe(true);
  });

  it("returns a least-authority tool facade without hidden Workspace capabilities", () => {
    const storage = new MemoryStorage();
    const { workspace } = memoryWorkspace();

    const bounded = createQuotaWorkspace(workspace, storage);

    expect(Object.keys(bounded)).toEqual(["fs"]);
    expect("runtime" in bounded).toBe(false);
    expect("git" in bounded).toBe(false);
    expect("assets" in bounded).toBe(false);
    expect("artifacts" in bounded).toBe(false);
    expect("mounts" in bounded).toBe(false);
    expect("provider" in bounded).toBe(false);
    expect("rename" in bounded.fs).toBe(false);
    expect("symlink" in bounded.fs).toBe(false);
    expect("chmod" in bounded.fs).toBe(false);
  });

  it("reconciles a shape-valid clean undercount after an untracked VFS revision", async () => {
    const storage = new MemoryStorage();
    const { workspace } = memoryWorkspace({ "/workspace/scratch/a.txt": "1234" });
    const bounded = createQuotaWorkspace(workspace, storage, 5, 2);
    await bounded.fs.writeFile("/workspace/scratch/b.txt", new TextEncoder().encode("x"));
    const clean = await storage.get<Record<string, unknown>>(WORKSPACE_QUOTA_STATE_KEY);
    storage.values.set(WORKSPACE_QUOTA_STATE_KEY, { ...clean, bytes: 0, entries: 0 });
    await workspace.fs.writeFile("/workspace/scratch/untracked.txt", new TextEncoder().encode("x"));

    await expect(
      bounded.fs.writeFile("/workspace/scratch/c.txt", new TextEncoder().encode("x"))
    ).rejects.toThrow(/quota/);
  });

  it("fails closed when the workspace or scratch root is a symlink", async () => {
    const storage = new MemoryStorage();
    const first = memoryWorkspace();
    first.files.set("/workspace", { symbolicLink: true });
    await expect(
      createQuotaWorkspace(first.workspace, storage).fs.writeFile(
        "/workspace/scratch/a.txt",
        new Uint8Array()
      )
    ).rejects.toThrow(/real directory/);

    const second = memoryWorkspace();
    second.files.set("/workspace/scratch", { symbolicLink: true });
    await expect(
      createQuotaWorkspace(second.workspace, new MemoryStorage()).fs.writeFile(
        "/workspace/scratch/a.txt",
        new Uint8Array()
      )
    ).rejects.toThrow(/real directory/);
  });

  it("does not create deep parents before file and byte quota preflight", async () => {
    const storage = new MemoryStorage();
    const { workspace, files } = memoryWorkspace();
    const bounded = createQuotaWorkspace(workspace, storage, 1, 2);

    await bounded.fs.mkdir("/workspace/scratch/a/b/c", { recursive: true });
    expect(files.has("/workspace/scratch/a")).toBe(false);
    await expect(
      bounded.fs.writeFile("/workspace/scratch/a/b/c/file.txt", new TextEncoder().encode("xx"))
    ).rejects.toThrow(/quota/);
    expect([...files.keys()].filter((path) => path.startsWith("/workspace/scratch/a"))).toEqual([]);
  });

  it("removes newly-created empty parents after a failed deep write", async () => {
    const storage = new MemoryStorage();
    const { workspace, files, failures } = memoryWorkspace();
    const bounded = createQuotaWorkspace(workspace, storage, 10, 10);
    failures.nextWrite = true;

    await expect(
      bounded.fs.writeFile("/workspace/scratch/a/b/file.txt", new TextEncoder().encode("x"))
    ).rejects.toThrow("write failed");

    expect([...files.keys()].filter((path) => path.startsWith("/workspace/scratch/a"))).toEqual([]);
    await expect(storage.get(WORKSPACE_QUOTA_STATE_KEY)).resolves.toMatchObject({
      version: 2,
      bytes: 0,
      entries: 0,
      dirty: false,
    });
  });

  it("cleans reserved empty parents after eviction between mkdir and file write", async () => {
    const storage = new MemoryStorage();
    const { workspace, files, revision } = memoryWorkspace();
    await workspace.fs.mkdir("/workspace/scratch/a/b", { recursive: true });
    storage.values.set(WORKSPACE_QUOTA_STATE_KEY, {
      version: 2,
      bytes: 0,
      entries: 0,
      dirty: true,
      vfsRevision: revision(),
      pendingWrite: {
        path: "/workspace/scratch/a/b/file.txt",
        newParents: ["/workspace/scratch/a", "/workspace/scratch/a/b"],
      },
    });
    const reopened = createQuotaWorkspace(workspace, storage, 10, 10);

    await reopened.fs.writeFile("/workspace/scratch/kept.txt", new TextEncoder().encode("x"));

    expect(files.has("/workspace/scratch/a")).toBe(false);
    expect(files.has("/workspace/scratch/a/b")).toBe(false);
    await expect(storage.get(WORKSPACE_QUOTA_STATE_KEY)).resolves.toMatchObject({
      version: 2,
      bytes: 1,
      entries: 1,
      dirty: false,
    });
  });
});

describe("createCoordinatedWorkspaceToolFacade", () => {
  it("keeps concurrent rollback from undoing a Computer execution result", async () => {
    const database = new RollbackQueueDatabase();
    const execution = deferred<void>();
    const rollback = deferred<void>();
    const concurrentStarted = deferred<void>();
    const handle = runtimeHandle(new ReadableStream(), async () => {
      await execution.promise;
      database.records.push("computer");
      return {
        status: "completed",
        exitCode: 0,
        stdout: "done",
        stderr: "",
        pushed: 0,
        pulled: 0,
        skipped: [],
        sync: { status: "complete", applied: 0, skipped: [] },
      };
    });
    const runtime = coordinatedRuntime(database, async () => handle);

    const running = await runtime.exec("export default 1", { encoding: "utf8" });
    const result = running.result();
    const concurrent = database.transaction(async () => {
      database.records.push("concurrent");
      concurrentStarted.resolve();
      await rollback.promise;
      throw new Error("rollback concurrent transaction");
    });

    await allowQueuedTransactionToStart();
    expect(database.records).toEqual([]);

    execution.resolve();
    await expect(result).resolves.toMatchObject({ stdout: "done" });
    await concurrentStarted.promise;
    rollback.resolve();
    await expect(concurrent).rejects.toThrow("rollback concurrent transaction");
    expect(database.records).toEqual(["computer"]);
  });

  it("holds the database queue through terminal streamed events", async () => {
    const database = new RollbackQueueDatabase();
    let events!: ReadableStreamDefaultController<WorkspaceRuntimeEvent<"utf8">>;
    const source = new ReadableStream<WorkspaceRuntimeEvent<"utf8">>({
      start(controller) {
        events = controller;
      },
    });
    const handle = runtimeHandle(source, async () => {
      throw new Error("result should not be used while streaming");
    });
    const runtime = coordinatedRuntime(database, async () => handle);
    const running = await runtime.exec("export default 1", { encoding: "utf8" });
    const reader = running.getReader();
    const concurrentStarted = deferred<void>();
    let didStartConcurrent = false;
    const concurrent = database.transaction(async () => {
      didStartConcurrent = true;
      concurrentStarted.resolve();
    });

    const first = reader.read();
    events.enqueue({ id: "exec-1", seq: 1, name: "stdout", value: "live" });
    await expect(first).resolves.toEqual({
      done: false,
      value: { id: "exec-1", seq: 1, name: "stdout", value: "live" },
    });
    await allowQueuedTransactionToStart();
    expect(didStartConcurrent).toBe(false);

    const terminal = reader.read();
    events.close();
    await expect(terminal).resolves.toEqual({ done: true, value: undefined });
    await concurrentStarted.promise;
    await concurrent;
  });

  it("forwards execution abort and releases only after its terminal event", async () => {
    const database = new RollbackQueueDatabase();
    let events!: ReadableStreamDefaultController<WorkspaceRuntimeEvent<"utf8">>;
    const source = new ReadableStream<WorkspaceRuntimeEvent<"utf8">>({
      start(controller) {
        events = controller;
      },
    });
    const killed = deferred<string | undefined>();
    const handle = runtimeHandle(
      source,
      async () => {
        throw new Error("result should not be used while streaming");
      },
      async (signal) => {
        killed.resolve(signal);
      }
    );
    const runtime = coordinatedRuntime(database, async () => handle);
    const running = await runtime.exec("while (true) {}", { encoding: "utf8" });
    const reader = running.getReader();
    const terminal = reader.read();
    let concurrentStarted = false;
    const concurrent = database.transaction(async () => {
      concurrentStarted = true;
    });

    await running.kill("SIGTERM");
    await expect(killed.promise).resolves.toBe("SIGTERM");
    expect(concurrentStarted).toBe(false);
    events.close();
    await expect(terminal).resolves.toEqual({ done: true, value: undefined });
    await concurrent;
    expect(concurrentStarted).toBe(true);
  });
});

describe("WorkspaceMutationFifo", () => {
  it("continues in admission order after a failed mutation", async () => {
    const fifo = new WorkspaceMutationFifo();
    const order: string[] = [];

    const first = fifo.run(async () => {
      order.push("first");
      throw new Error("failed");
    });
    const second = fifo.run(async () => {
      order.push("second");
      return "done";
    });

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("done");
    expect(order).toEqual(["first", "second"]);
  });
});
