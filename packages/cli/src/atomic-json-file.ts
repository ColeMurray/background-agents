import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (process.platform !== "win32") await chmod(path, 0o600);
    return value;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

export async function updateJsonFile<T>(
  path: string,
  read: (value: unknown | undefined) => T,
  update: (value: T) => void
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${path}.lock`);
  try {
    const value = read(await readJsonFile(path));
    update(value);
    await writeJsonFile(path, value);
    return value;
  } finally {
    await release();
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (cause) {
    await rm(temporaryPath, { force: true });
    throw cause;
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      return () => rm(path, { force: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      try {
        if (Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_MS) await rm(path);
      } catch (lockCause) {
        if ((lockCause as NodeJS.ErrnoException).code !== "ENOENT") throw lockCause;
      }
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for configuration lock: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}
