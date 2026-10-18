import type { Workspace } from "@cloudflare/computer";

export const COMPUTER_SCRATCH_ROOT = "/workspace/scratch";
const SCAN_PAGE_SIZE = 1_000;

export const WORKSPACE_QUOTA_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_QUOTA_ENTRIES = 1_000;
export const WORKSPACE_QUOTA_STATE_KEY = "open-inspect:workspace-quota";

interface WorkspaceQuotaState {
  bytes: number;
  entries: number;
  dirty: boolean;
}

interface WorkspaceQuotaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
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

/**
 * Add durable aggregate accounting to Computer's filesystem without exposing
 * the Workspace, runtime, Git, assets, or mounts to tool code.
 */
export function createQuotaWorkspace(
  workspace: Workspace,
  storage: WorkspaceQuotaStorage,
  quotaBytes = WORKSPACE_QUOTA_BYTES,
  quotaEntries = WORKSPACE_QUOTA_ENTRIES
): Workspace {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0) {
    throw new Error("Workspace quota must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(quotaEntries) || quotaEntries < 0) {
    throw new Error("Workspace entry quota must be a non-negative safe integer");
  }
  const filesystem = workspace.fs;

  async function readState(): Promise<WorkspaceQuotaState> {
    const stored = await storage.get<unknown>(WORKSPACE_QUOTA_STATE_KEY);
    if (isQuotaState(stored) && !stored.dirty) return stored;
    return recoverState();
  }

  async function recoverState(): Promise<WorkspaceQuotaState> {
    const state = { ...(await aggregateUsage(workspace)), dirty: false };
    await storage.put(WORKSPACE_QUOTA_STATE_KEY, state);
    return state;
  }

  async function markDirty(state: WorkspaceQuotaState): Promise<void> {
    await storage.put(WORKSPACE_QUOTA_STATE_KEY, { ...state, dirty: true });
  }

  async function writeFile(
    path: string,
    content: Parameters<typeof filesystem.writeFile>[1],
    options?: Parameters<typeof filesystem.writeFile>[2]
  ): Promise<void> {
    const resolvedPath = requireWorkspacePath(path);
    const state = await readState();
    const existing = await pathUsage(filesystem, resolvedPath);
    const nextEntries = state.entries + (existing.exists ? 0 : 1);
    if (nextEntries > quotaEntries) {
      throw new Error(`Workspace entry quota exceeded (${nextEntries} > ${quotaEntries} entries)`);
    }
    const bytes = await materializeContent(content, quotaBytes - state.bytes + existing.bytes);
    const nextBytes = state.bytes - existing.bytes + bytes.byteLength;
    if (nextBytes > quotaBytes) {
      throw new Error(`Workspace quota exceeded (${nextBytes} > ${quotaBytes} bytes)`);
    }
    await markDirty(state);
    try {
      await filesystem.writeFile(resolvedPath, bytes, options);
      await storage.put(WORKSPACE_QUOTA_STATE_KEY, {
        bytes: nextBytes,
        entries: nextEntries,
        dirty: false,
      });
    } catch (error) {
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

  async function mkdir(
    path: string,
    options?: Parameters<typeof filesystem.mkdir>[1]
  ): Promise<void> {
    const resolvedPath = requireWorkspacePath(path);
    const state = await readState();
    const createdEntries = await missingDirectoryCount(filesystem, resolvedPath);
    const nextEntries = state.entries + createdEntries;
    if (nextEntries > quotaEntries) {
      throw new Error(`Workspace entry quota exceeded (${nextEntries} > ${quotaEntries} entries)`);
    }
    if (createdEntries === 0) {
      await filesystem.mkdir(resolvedPath, options);
      return;
    }
    await markDirty(state);
    try {
      await filesystem.mkdir(resolvedPath, options);
      await recoverState();
    } catch (error) {
      await recoverState().catch(() => {});
      throw error;
    }
  }

  const quotaFilesystem = new Proxy(filesystem, {
    get(target, property) {
      if (property === "writeFile") return writeFile;
      if (property === "rm") return remove;
      if (property === "mkdir") return mkdir;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new Proxy(workspace, {
    get(target, property) {
      if (property === "fs") return quotaFilesystem;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function isWorkspaceRoot(path: string): boolean {
  return resolveWorkspacePath(path) === COMPUTER_SCRATCH_ROOT;
}

export function isProtectedWorkspaceRoot(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "/workspace" || normalized === COMPUTER_SCRATCH_ROOT;
}

export function resolveWorkspacePath(path: string): string | null {
  const normalized = normalizeWorkspacePath(path);
  return normalized === COMPUTER_SCRATCH_ROOT || normalized.startsWith(`${COMPUTER_SCRATCH_ROOT}/`)
    ? normalized
    : null;
}

function normalizeWorkspacePath(path: string): string {
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
    Number.isSafeInteger(candidate.bytes) &&
    (candidate.bytes ?? -1) >= 0 &&
    Number.isSafeInteger(candidate.entries) &&
    (candidate.entries ?? -1) >= 0 &&
    typeof candidate.dirty === "boolean"
  );
}

async function aggregateUsage(
  workspace: Workspace
): Promise<Pick<WorkspaceQuotaState, "bytes" | "entries">> {
  const pending = [COMPUTER_SCRATCH_ROOT];
  let bytes = 0;
  let entryCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
      const page = await workspace.fs.readdir(directory, {
        limit: SCAN_PAGE_SIZE,
        offset,
      });
      for (const entry of page) {
        entryCount += 1;
        const path = `${directory === "/" ? "" : directory}/${entry.name}`;
        if (entry.isFile) {
          bytes += entry.size;
          if (!Number.isSafeInteger(bytes)) throw new Error("Workspace byte count overflowed");
        } else if (entry.isDirectory && !entry.isSymbolicLink) {
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
): Promise<{ exists: boolean; bytes: number }> {
  try {
    const stat = await filesystem.lstat(path);
    return { exists: true, bytes: stat.isFile ? stat.size : 0 };
  } catch (error) {
    if (isMissing(error)) return { exists: false, bytes: 0 };
    throw error;
  }
}

async function missingDirectoryCount(filesystem: Workspace["fs"], path: string): Promise<number> {
  if (path === COMPUTER_SCRATCH_ROOT) return 0;
  const relative = path.slice(`${COMPUTER_SCRATCH_ROOT}/`.length).split("/");
  let current = COMPUTER_SCRATCH_ROOT;
  for (let index = 0; index < relative.length; index++) {
    current = `${current}/${relative[index]}`;
    try {
      await filesystem.lstat(current);
    } catch (error) {
      if (isMissing(error)) return relative.length - index;
      throw error;
    }
  }
  return 0;
}

function requireWorkspacePath(path: string): string {
  const resolved = resolveWorkspacePath(path);
  if (resolved === null) throw new Error(`Path is outside ${COMPUTER_SCRATCH_ROOT}: ${path}`);
  return resolved;
}

async function materializeContent(
  content: Parameters<Workspace["fs"]["writeFile"]>[1],
  availableBytes: number
): Promise<Uint8Array> {
  if (typeof content === "string") return new TextEncoder().encode(content);
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
    (typeof candidate.message === "string" && /ENOENT|no such/i.test(candidate.message))
  );
}
