import type { SandboxProvider } from "../sandbox/provider";

export class SandboxDeadlineError extends Error {}

export async function runSandboxOperationBeforeDeadline<T>(
  now: () => number,
  deadlineAtMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(
          new SandboxDeadlineError("Provider graceful shutdown deadline exceeded; result unknown")
        );
      },
      Math.max(0, deadlineAtMs - now())
    );
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Invokes one snapshot before its deadline and accepts only a verified artifact identifier. */
export async function captureSandboxSnapshot(
  provider: SandboxProvider,
  now: () => number,
  providerObjectId: string,
  sessionId: string,
  reason: string,
  deadlineAtMs: number
): Promise<{ imageId: string; sourceStopped: boolean }> {
  if (!provider.takeSnapshot) throw new Error("Provider has no snapshot operation");
  const result = await runSandboxOperationBeforeDeadline(now, deadlineAtMs, (signal) =>
    provider.takeSnapshot!({ providerObjectId, sessionId, reason, deadlineAtMs, signal })
  );
  if (!result.success || !result.imageId)
    throw new Error(result.error ?? "Provider snapshot result is unknown");
  return { imageId: result.imageId, sourceStopped: result.sourceStopped === true };
}
