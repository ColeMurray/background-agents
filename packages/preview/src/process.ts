import type { ChildProcess } from "node:child_process";

const CHILD_STOP_TIMEOUT_MS = 5000;

/** Whether a process with this ID runs, including one this user may not signal. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Stops a detached child's entire group, even if its parent has already exited. */
export async function stopChildGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(-child.pid!, name);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (signal("SIGTERM")) {
    const deadline = Date.now() + CHILD_STOP_TIMEOUT_MS;
    while (signal(0) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    signal("SIGKILL");
  }
  await exited;
}

export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | false>,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== false) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
