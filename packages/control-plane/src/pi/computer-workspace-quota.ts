import type {
  ExecEncoding,
  Workspace,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeResult,
} from "@cloudflare/computer";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";

export const COMPUTER_SCRATCH_ROOT = "/workspace/scratch";
const WORKSPACE_ROOT = "/workspace";
const SCAN_PAGE_SIZE = 1_000;
const QUOTA_STATE_VERSION = 2 as const;

export const WORKSPACE_QUOTA_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_QUOTA_ENTRIES = 1_000;
export const WORKSPACE_QUOTA_STATE_KEY = "open-inspect:workspace-quota";

interface PendingWrite {
  path: string;
  newParents: string[];
}

interface WorkspaceQuotaState {
  version: typeof QUOTA_STATE_VERSION;
  bytes: number;
  entries: number;
  dirty: boolean;
  vfsRevision: number;
  pendingWrite?: PendingWrite;
}

interface WorkspaceQuotaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

type ToolFileSystem = Pick<
  Workspace["fs"],
  "stat" | "lstat" | "readFile" | "writeFile" | "mkdir" | "rm" | "find" | "grep" | "readdir"
>;
type ToolRuntime = Pick<Workspace["runtime"], "exec" | "backends">;

/** The complete object handed to Computer's tool adapter. No Workspace authority is reachable. */
export interface WorkspaceToolFacade {
  readonly fs: ToolFileSystem;
  readonly runtime?: ToolRuntime;
}

/**
 * Hold Pi's shared queue while Computer runs its synchronous database work.
 * Computer owns rollback through its nested transactionSync savepoints; an
 * operation error is rethrown only after the queue-holding transaction ends.
 */
export async function runCoordinatedComputerOperation<T>(
  database: SqliteDatabase,
  operation: () => T | Promise<T>
): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  await database.transaction(async () => {
    try {
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }
  });
  if (!outcome) throw new Error("Computer SQLite operation did not settle");
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Add only Computer's execution surface, never the owning Workspace. */
export function withWorkspaceRuntime(
  facade: WorkspaceToolFacade,
  workspace: Workspace
): WorkspaceToolFacade {
  return {
    ...facade,
    runtime: {
      exec: workspace.runtime.exec.bind(workspace.runtime),
      backends: workspace.runtime.backends.bind(workspace.runtime),
    },
  };
}

/**
 * Serialize Computer's synchronous SQLite internals with pi-durable's async
 * adapter queue. The outer Durable Object transaction is the queue holder;
 * Computer's own transactionSync calls remain nested savepoints.
 */
export function createCoordinatedWorkspaceToolFacade(
  workspace: WorkspaceToolFacade,
  database: SqliteDatabase
): WorkspaceToolFacade {
  const coordinate = <T>(operation: () => T | Promise<T>): Promise<T> =>
    runCoordinatedComputerOperation(database, operation);
  const filesystem = workspace.fs;
  return {
    fs: {
      stat: ((...args: Parameters<ToolFileSystem["stat"]>) =>
        coordinate(() => filesystem.stat(...args))) as ToolFileSystem["stat"],
      lstat: ((...args: Parameters<ToolFileSystem["lstat"]>) =>
        coordinate(() => filesystem.lstat(...args))) as ToolFileSystem["lstat"],
      readFile: ((...args: Parameters<ToolFileSystem["readFile"]>) =>
        coordinate(() => filesystem.readFile(...args))) as ToolFileSystem["readFile"],
      writeFile: ((...args: Parameters<ToolFileSystem["writeFile"]>) =>
        coordinate(() => filesystem.writeFile(...args))) as ToolFileSystem["writeFile"],
      mkdir: ((...args: Parameters<ToolFileSystem["mkdir"]>) =>
        coordinate(() => filesystem.mkdir(...args))) as ToolFileSystem["mkdir"],
      rm: ((...args: Parameters<ToolFileSystem["rm"]>) =>
        coordinate(() => filesystem.rm(...args))) as ToolFileSystem["rm"],
      find: ((...args: Parameters<ToolFileSystem["find"]>) =>
        coordinate(() => filesystem.find(...args))) as ToolFileSystem["find"],
      grep: ((...args: Parameters<ToolFileSystem["grep"]>) =>
        coordinate(() => filesystem.grep(...args))) as ToolFileSystem["grep"],
      readdir: ((...args: Parameters<ToolFileSystem["readdir"]>) =>
        coordinate(() => filesystem.readdir(...args))) as ToolFileSystem["readdir"],
    },
    ...(workspace.runtime
      ? {
          runtime: {
            exec: ((...args: Parameters<ToolRuntime["exec"]>) =>
              coordinateComputerExecution(database, () =>
                workspace.runtime!.exec(...args)
              )) as ToolRuntime["exec"],
            backends: workspace.runtime.backends.bind(workspace.runtime),
          },
        }
      : {}),
  };
}

/**
 * Keep the adapter transaction queued until Computer has finished using its
 * synchronous SQLite connection. runtime.exec only spawns the execution; the
 * database work continues while result() or the handle's event stream runs.
 */
async function coordinateComputerExecution<E extends ExecEncoding>(
  database: SqliteDatabase,
  spawn: () => Promise<WorkspaceRuntimeExecHandle<E>>
): Promise<WorkspaceRuntimeExecHandle<E>> {
  const spawned = deferred<
    { ok: true; handle: WorkspaceRuntimeExecHandle<E> } | { ok: false; error: unknown }
  >();
  const completed = deferred<void>();
  let transactionFailure: { error: unknown } | undefined;

  const transactionSettled = database
    .transaction(async () => {
      try {
        const handle = await spawn();
        spawned.resolve({ ok: true, handle });
        await completed.promise;
      } catch (error) {
        spawned.resolve({ ok: false, error });
      }
    })
    .catch((error: unknown) => {
      transactionFailure = { error };
      spawned.resolve({ ok: false, error });
    });

  const outcome = await spawned.promise;
  if (!outcome.ok) {
    await transactionSettled;
    if (transactionFailure) throw transactionFailure.error;
    throw outcome.error;
  }

  return retainComputerExecutionQueue(outcome.handle, completed.resolve, async () => {
    await transactionSettled;
    if (transactionFailure) throw transactionFailure.error;
  });
}

function retainComputerExecutionQueue<E extends ExecEncoding>(
  handle: WorkspaceRuntimeExecHandle<E>,
  releaseTransaction: () => void,
  waitForTransaction: () => Promise<void>
): WorkspaceRuntimeExecHandle<E> {
  let released = false;
  let reader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent<E>> | undefined;

  const release = async (): Promise<void> => {
    if (!released) {
      released = true;
      releaseTransaction();
    }
    await waitForTransaction();
  };
  const releaseAfter = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      const value = await operation();
      await release();
      return value;
    } catch (error) {
      await release();
      throw error;
    }
  };

  const stream = new ReadableStream<WorkspaceRuntimeEvent<E>>(
    {
      async pull(controller) {
        reader ??= handle.getReader();
        try {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          reader.releaseLock();
          reader = undefined;
          await release();
          controller.close();
        } catch (error) {
          reader?.releaseLock();
          reader = undefined;
          try {
            await release();
            controller.error(error);
          } catch (transactionFailure) {
            controller.error(transactionFailure);
          }
        }
      },
      async cancel(reason) {
        const activeReader = reader;
        reader = undefined;
        try {
          if (activeReader) await activeReader.cancel(reason);
          else await handle.cancel(reason);
        } finally {
          activeReader?.releaseLock();
          await release();
        }
      },
    },
    { highWaterMark: 0 }
  );

  Object.defineProperties(stream, {
    id: { value: handle.id, enumerable: false },
    backend: { value: handle.backend, enumerable: false },
    result: {
      value: (): Promise<WorkspaceRuntimeResult<E>> => releaseAfter(() => handle.result()),
      enumerable: false,
    },
    kill: {
      value: (signal?: Parameters<WorkspaceRuntimeExecHandle<E>["kill"]>[0]) => handle.kill(signal),
      enumerable: false,
    },
    [Symbol.dispose]: {
      value: () => {
        const activeReader = reader;
        reader = undefined;
        if (activeReader) {
          void activeReader
            .cancel()
            .catch(() => {})
            .finally(() => activeReader.releaseLock())
            .then(release)
            .catch(() => {});
        } else {
          handle[Symbol.dispose]();
          void release().catch(() => {});
        }
      },
      enumerable: false,
    },
  });
  return stream as WorkspaceRuntimeExecHandle<E>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** One workspace-wide admission queue for every mutating tool in a Pi session. */
export class WorkspaceMutationFifo {
  private tail: Promise<void> = Promise.resolve();

  run<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(mutation, mutation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** Build a read-only-in-authority facade sufficient for createPiTools. */
export function createWorkspaceToolFacade(workspace: Workspace): WorkspaceToolFacade {
  const filesystem = workspace.fs;
  return {
    fs: {
      stat: filesystem.stat.bind(filesystem),
      lstat: filesystem.lstat.bind(filesystem),
      readFile: filesystem.readFile.bind(filesystem),
      writeFile: filesystem.writeFile.bind(filesystem),
      mkdir: filesystem.mkdir.bind(filesystem),
      rm: filesystem.rm.bind(filesystem),
      find: filesystem.find.bind(filesystem),
      grep: filesystem.grep.bind(filesystem),
      readdir: filesystem.readdir.bind(filesystem),
    },
  };
}

/** Defer Computer construction until a model actually invokes a workspace tool. */
export function createLazyWorkspaceToolFacade(
  open: () => Promise<WorkspaceToolFacade>
): WorkspaceToolFacade {
  let opened: Promise<WorkspaceToolFacade> | undefined;
  const get = () => (opened ??= open());
  const method =
    (name: keyof ToolFileSystem) =>
    (...args: unknown[]) =>
      get().then((workspace) =>
        Reflect.apply(workspace.fs[name] as (...values: unknown[]) => unknown, workspace.fs, args)
      );
  return {
    fs: {
      stat: method("stat") as ToolFileSystem["stat"],
      lstat: method("lstat") as ToolFileSystem["lstat"],
      readFile: method("readFile") as ToolFileSystem["readFile"],
      writeFile: method("writeFile") as ToolFileSystem["writeFile"],
      mkdir: method("mkdir") as ToolFileSystem["mkdir"],
      rm: method("rm") as ToolFileSystem["rm"],
      find: method("find") as ToolFileSystem["find"],
      grep: method("grep") as ToolFileSystem["grep"],
      readdir: method("readdir") as ToolFileSystem["readdir"],
    },
  };
}

/**
 * Add durable aggregate scratch accounting while returning only the small
 * filesystem surface Computer's tools require.
 */
export function createQuotaWorkspace(
  workspace: Workspace,
  storage: WorkspaceQuotaStorage,
  quotaBytes = WORKSPACE_QUOTA_BYTES,
  quotaEntries = WORKSPACE_QUOTA_ENTRIES
): WorkspaceToolFacade {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0) {
    throw new Error("Workspace quota must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(quotaEntries) || quotaEntries < 0) {
    throw new Error("Workspace entry quota must be a non-negative safe integer");
  }
  const filesystem = workspace.fs;

  const currentRevision = (): number => {
    const revision = workspace.db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("Workspace VFS revision is invalid");
    }
    return revision;
  };

  async function readState(): Promise<WorkspaceQuotaState> {
    const stored = await storage.get<unknown>(WORKSPACE_QUOTA_STATE_KEY);
    if (isQuotaState(stored) && !stored.dirty && stored.vfsRevision === currentRevision()) {
      await verifyWorkspaceRoots(filesystem);
      return stored;
    }
    return recoverState(isQuotaState(stored) ? stored.pendingWrite : undefined);
  }

  async function recoverState(pendingWrite?: PendingWrite): Promise<WorkspaceQuotaState> {
    await verifyWorkspaceRoots(filesystem);
    if (pendingWrite) await cleanAbandonedParents(filesystem, pendingWrite);
    const usage = await aggregateUsage(filesystem);
    const state: WorkspaceQuotaState = {
      version: QUOTA_STATE_VERSION,
      ...usage,
      dirty: false,
      vfsRevision: currentRevision(),
    };
    await storage.put(WORKSPACE_QUOTA_STATE_KEY, state);
    return state;
  }

  async function markDirty(state: WorkspaceQuotaState, pendingWrite?: PendingWrite): Promise<void> {
    await storage.put(WORKSPACE_QUOTA_STATE_KEY, {
      ...state,
      dirty: true,
      ...(pendingWrite ? { pendingWrite } : {}),
    });
  }

  async function writeFile(
    path: string,
    content: Parameters<typeof filesystem.writeFile>[1],
    options?: Parameters<typeof filesystem.writeFile>[2]
  ): Promise<void> {
    const resolvedPath = requireWorkspacePath(path);
    const state = await readState();
    const existing = await pathUsage(filesystem, resolvedPath);
    if (existing.exists && !existing.isFile)
      throw new Error("Workspace write target is not a file");
    const newParents = await missingDirectories(filesystem, parentPath(resolvedPath));
    const bytes = await materializeContent(content, quotaBytes - state.bytes + existing.bytes);
    const nextBytes = state.bytes - existing.bytes + bytes.byteLength;
    const nextEntries = state.entries + newParents.length + (existing.exists ? 0 : 1);
    if (nextEntries > quotaEntries) {
      throw new Error(`Workspace entry quota exceeded (${nextEntries} > ${quotaEntries} entries)`);
    }
    if (nextBytes > quotaBytes) {
      throw new Error(`Workspace quota exceeded (${nextBytes} > ${quotaBytes} bytes)`);
    }
    const pendingWrite = { path: resolvedPath, newParents };
    await markDirty(state, pendingWrite);
    try {
      for (const directory of newParents) {
        await filesystem.mkdir(directory);
        await requireRealDirectory(filesystem, directory);
      }
      await filesystem.writeFile(resolvedPath, bytes, options);
      await recoverState();
    } catch (error) {
      await cleanAbandonedParents(filesystem, pendingWrite).catch(() => {});
      await recoverState().catch(() => {});
      throw error;
    }
  }

  async function remove(
    path: string,
    options?: Parameters<typeof filesystem.rm>[1]
  ): Promise<void> {
    if (isProtectedWorkspaceRoot(path)) {
      throw new Error("Deleting the workspace root is not allowed");
    }
    const resolvedPath = requireWorkspacePath(path);
    const state = await readState();
    await markDirty(state);
    try {
      await filesystem.rm(resolvedPath, options);
      await recoverState();
    } catch (error) {
      await recoverState().catch(() => {});
      throw error;
    }
  }

  // Computer calls mkdir only as ensureParentDir immediately before writeFile.
  // Deferring creation lets writeFile reserve directories and file bytes atomically.
  async function reserveParent(path: string): Promise<void> {
    const resolvedPath = requireWorkspacePath(path);
    await verifyWorkspaceRoots(filesystem);
    const stat = await lstatOrNull(filesystem, resolvedPath);
    if (stat) {
      if (!stat.isDirectory || stat.isSymbolicLink) {
        throw new Error(`Workspace parent is not a real directory: ${resolvedPath}`);
      }
    }
  }

  return {
    fs: {
      stat: filesystem.stat.bind(filesystem),
      lstat: filesystem.lstat.bind(filesystem),
      readFile: filesystem.readFile.bind(filesystem),
      writeFile,
      mkdir: reserveParent,
      rm: remove,
      find: filesystem.find.bind(filesystem),
      grep: filesystem.grep.bind(filesystem),
      readdir: filesystem.readdir.bind(filesystem),
    },
  };
}

export async function ensureRealWorkspaceDirectory(
  filesystem: Workspace["fs"],
  path: string
): Promise<void> {
  const existing = await lstatOrNull(filesystem, path);
  if (!existing) await filesystem.mkdir(path, { recursive: true });
  await requireRealDirectory(filesystem, path);
}

export function isWorkspaceRoot(path: string): boolean {
  return resolveWorkspacePath(path) === COMPUTER_SCRATCH_ROOT;
}

export function isProtectedWorkspaceRoot(path: string): boolean {
  const normalized = normalizeWorkspaceAbsolutePath(path);
  return normalized === WORKSPACE_ROOT || normalized === COMPUTER_SCRATCH_ROOT;
}

export function resolveWorkspacePath(path: string): string | null {
  const normalized = normalizeWorkspaceAbsolutePath(path);
  return normalized === COMPUTER_SCRATCH_ROOT || normalized.startsWith(`${COMPUTER_SCRATCH_ROOT}/`)
    ? normalized
    : null;
}

export function normalizeWorkspaceAbsolutePath(path: string): string {
  const absolute = path.startsWith("/") ? path : `${COMPUTER_SCRATCH_ROOT}/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isQuotaState(value: unknown): value is WorkspaceQuotaState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkspaceQuotaState>;
  return (
    candidate.version === QUOTA_STATE_VERSION &&
    Number.isSafeInteger(candidate.bytes) &&
    (candidate.bytes ?? -1) >= 0 &&
    Number.isSafeInteger(candidate.entries) &&
    (candidate.entries ?? -1) >= 0 &&
    Number.isSafeInteger(candidate.vfsRevision) &&
    (candidate.vfsRevision ?? -1) >= 0 &&
    typeof candidate.dirty === "boolean" &&
    (candidate.pendingWrite === undefined || isPendingWrite(candidate.pendingWrite))
  );
}

function isPendingWrite(value: unknown): value is PendingWrite {
  if (!(
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    "newParents" in value &&
    Array.isArray(value.newParents) &&
    value.newParents.every((path) => typeof path === "string")
  ))
    return false;
  const path = resolveWorkspacePath(value.path);
  return (
    path !== null &&
    path !== COMPUTER_SCRATCH_ROOT &&
    value.newParents.every((parent) => {
      const resolved = resolveWorkspacePath(parent);
      return resolved !== null && resolved !== COMPUTER_SCRATCH_ROOT;
    })
  );
}

async function verifyWorkspaceRoots(filesystem: Workspace["fs"]): Promise<void> {
  await requireRealDirectory(filesystem, WORKSPACE_ROOT);
  await requireRealDirectory(filesystem, COMPUTER_SCRATCH_ROOT);
}

async function requireRealDirectory(filesystem: Workspace["fs"], path: string): Promise<void> {
  const stat = await filesystem.lstat(path);
  if (!stat.isDirectory || stat.isSymbolicLink) {
    throw new Error(`Workspace root must be a real directory: ${path}`);
  }
}

async function aggregateUsage(
  filesystem: Workspace["fs"]
): Promise<Pick<WorkspaceQuotaState, "bytes" | "entries">> {
  const pending = [COMPUTER_SCRATCH_ROOT];
  let bytes = 0;
  let entryCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
      const page = await filesystem.readdir(directory, { limit: SCAN_PAGE_SIZE, offset });
      for (const entry of page) {
        if (entry.isSymbolicLink) throw new Error("Workspace contains an unsafe symbolic link");
        entryCount += 1;
        const path = `${directory}/${entry.name}`;
        if (entry.isFile) {
          bytes += entry.size;
          if (!Number.isSafeInteger(bytes)) throw new Error("Workspace byte count overflowed");
        } else if (entry.isDirectory) {
          pending.push(path);
        }
      }
      if (!Number.isSafeInteger(entryCount)) throw new Error("Workspace entry count overflowed");
      if (page.length < SCAN_PAGE_SIZE) break;
    }
  }
  return { bytes, entries: entryCount };
}

async function pathUsage(
  filesystem: Workspace["fs"],
  path: string
): Promise<{ exists: boolean; bytes: number; isFile: boolean }> {
  const stat = await lstatOrNull(filesystem, path);
  if (!stat) return { exists: false, bytes: 0, isFile: false };
  if (stat.isSymbolicLink) throw new Error("Workspace path is an unsafe symbolic link");
  return { exists: true, bytes: stat.isFile ? stat.size : 0, isFile: stat.isFile };
}

async function missingDirectories(filesystem: Workspace["fs"], path: string): Promise<string[]> {
  if (path === COMPUTER_SCRATCH_ROOT) return [];
  const relative = path.slice(`${COMPUTER_SCRATCH_ROOT}/`.length).split("/");
  let current = COMPUTER_SCRATCH_ROOT;
  const missing: string[] = [];
  for (const segment of relative) {
    current = `${current}/${segment}`;
    const stat = await lstatOrNull(filesystem, current);
    if (!stat) {
      missing.push(current);
      continue;
    }
    if (!stat.isDirectory || stat.isSymbolicLink) {
      throw new Error(`Workspace parent is not a real directory: ${current}`);
    }
  }
  return missing;
}

async function cleanAbandonedParents(
  filesystem: Workspace["fs"],
  pending: PendingWrite
): Promise<void> {
  if (await lstatOrNull(filesystem, pending.path)) return;
  for (const directory of [...pending.newParents].reverse()) {
    await filesystem.rm(directory, { force: true }).catch(() => {});
  }
}

function requireWorkspacePath(path: string): string {
  const resolved = resolveWorkspacePath(path);
  if (resolved === null) throw new Error(`Path is outside ${COMPUTER_SCRATCH_ROOT}: ${path}`);
  return resolved;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

async function lstatOrNull(filesystem: Workspace["fs"], path: string) {
  try {
    return await filesystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function materializeContent(
  content: Parameters<Workspace["fs"]["writeFile"]>[1],
  availableBytes: number
): Promise<Uint8Array> {
  if (typeof content === "string") {
    if (content.length > availableBytes) throw new Error("Workspace quota exceeded while writing");
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) return content;
  const reader = content.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > availableBytes)
        throw new Error("Workspace quota exceeded while streaming a file");
      chunks.push(value);
    }
  } finally {
    try {
      if (!completed) await reader.cancel().catch(() => {});
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "ENOENT" ||
    (typeof candidate.message === "string" && /ENOENT|no such|not found/i.test(candidate.message))
  );
}
