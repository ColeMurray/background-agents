import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startPreviewBackend, unusedPort, type PreviewBackend } from "./backend";
import {
  PREVIEW_LIFETIME_MS,
  PREVIEW_REQUEST_TIMEOUT_MS,
  webEnvFileKeys,
  webEnvironment,
} from "./config";
import { PERSONAS } from "./personas";
import { waitFor } from "./scenarios";
import { readLogTail, sanitizedDiagnostic } from "./diagnostics";
import { startSignInLinks, type SignInLinks } from "./sign-in-links";
import type { PreviewManifest, PreviewStackHandle, PreviewStackOptions } from "./contracts";

const exec = promisify(execFile);
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** The stack as the CLI drives it. Extending the handle keeps the browser suite's contract checked. */
export interface PreviewStack extends PreviewStackHandle {
  manifestPath: string;
  backend: PreviewBackend;
  recordFailure(error: unknown): Promise<string>;
}

/** One Next process per checkout. Never attaches to or kills an unrelated process. */
export async function startPreviewStack(options: PreviewStackOptions): Promise<PreviewStack> {
  const root = resolve(options.root);
  const startedAtMs = Date.now();
  const stage = (name: string) => {
    options.signal?.throwIfAborted();
    options.onStage?.(name);
  };
  stage("preflight");
  const workDir = join(root, ".preview");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const lockPath = join(workDir, "lock.json");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error(
      `preflight: checkout already owned; inspect ${lockPath}. Stop its preview before starting another.`
    );
  }
  let runDir: string | undefined;
  let backend: PreviewBackend | undefined;
  let signInLinks: SignInLinks | undefined;
  let next: ChildProcess | undefined;
  let log: ReturnType<typeof createWriteStream> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  const secrets = new Set<string>();
  const diagnosticPath = join(workDir, "last-failure.log");
  const recordedFailures: unknown[] = [];
  const readWebLog = async () => (runDir ? await readLogTail(join(runDir, "web.log")) : "");
  const writeDiagnostic = async (webLog: string) => {
    await writeFile(
      diagnosticPath,
      sanitizedDiagnostic(new AggregateError(recordedFailures, "Preview failed"), webLog, secrets),
      { mode: 0o600 }
    );
  };
  const recordFailure = async (error: unknown) => {
    recordedFailures.push(error);
    await writeDiagnostic(await readWebLog());
    return diagnosticPath;
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(monitor);
      clearTimeout(lifetime);
      const errors: unknown[] = [];
      // Every release is attempted even after one fails; a skipped one can strand the lock.
      const release = async (step: () => unknown) => {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      };
      await release(() => signInLinks?.close());
      await release(() => next && stopChild(next));
      await release(() => backend?.close());
      await release(() => log && new Promise<void>((resolve) => log!.end(resolve)));
      const webLog = await readWebLog();
      await release(() => runDir && rm(runDir, { recursive: true, force: true }));
      await release(() => lock.close());
      await release(() => rm(lockPath));
      // Last, so the retained diagnostic includes failures of the final releases too.
      recordedFailures.push(...errors);
      if (recordedFailures.length) await release(() => writeDiagnostic(webLog));
      if (errors.length)
        throw new AggregateError(
          errors,
          `shutdown: preview did not close cleanly; sanitized diagnostic: ${diagnosticPath}`
        );
    })());
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAtMs, root }));
    // Next owns these locks too; do not remove even a stale-looking Next lock automatically.
    for (const name of [".next/dev/lock", ".next/lock"]) {
      if (
        await stat(join(root, "packages/web", name)).then(
          () => true,
          () => false
        )
      )
        throw new Error(
          `preflight: Next lock exists at packages/web/${name}; stop the existing dev/build process first.`
        );
    }
    runDir = await mkdtemp(join(tmpdir(), "oi-preview-"));
    await chmod(runDir, 0o700);
    const runId = randomUUID().slice(0, 8);
    const sourceRevision = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const dirty = Boolean(
      (
        await exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root })
      ).stdout.trim()
    );
    let webOrigin = "";
    let webReadyAtMs = 0;
    let backendMs = 0;
    let nextError: Error | undefined;
    // Probing is not reserving. EADDRINUSE or a child exit tears down this attempt.
    for (let attempt = 0; attempt < 3; attempt++) {
      stage("control-plane");
      const webPort = await unusedPort();
      webOrigin = `http://127.0.0.1:${webPort}`;
      const attemptDir = join(runDir, `attempt-${attempt}`);
      await mkdir(attemptDir, { mode: 0o700 });
      const backendStart = Date.now();
      try {
        backend = await startPreviewBackend({
          root,
          runDir: attemptDir,
          webOrigin,
          scenario: options.scenario ?? "populated",
          signal: options.signal,
        });
        for (const [key, value] of Object.entries(backend.config))
          if (/SECRET|KEY|TOKEN/.test(key) && value) secrets.add(value);
        for (const identity of Object.values(backend.identities)) {
          secrets.add(identity.cookieHeader);
          for (const cookie of identity.storageState.cookies) secrets.add(cookie.value);
        }
        backendMs = Date.now() - backendStart;
        stage("web");
        const logPath = join(runDir, "web.log");
        log = createWriteStream(logPath, { mode: 0o600 });
        nextError = undefined;
        const envFileKeys = await webEnvFileKeys(join(root, "packages/web"));
        next = spawn(
          process.execPath,
          [
            join(root, "node_modules/next/dist/bin/next"),
            "dev",
            "--hostname",
            "127.0.0.1",
            "--port",
            String(webPort),
          ],
          {
            cwd: join(root, "packages/web"),
            env: webEnvironment(process.env, backend.config, envFileKeys),
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        next.stdout!.pipe(log);
        next.stderr!.pipe(log);
        next.on("error", (error) => {
          nextError = error;
        });
        next.on("exit", (code, signal) => {
          nextError = new Error(`web: Next exited (${signal ?? code}); inspect ${logPath}`);
        });
        // Until Next responds, a refusal is expected. A returned non-200 is not readiness.
        await waitFor(
          "Next and authenticated BFF (inspect web.log for compile errors)",
          async () => {
            options.signal?.throwIfAborted();
            if (nextError) throw nextError;
            try {
              const response = await fetch(`${webOrigin}/api/auth/get-session`, {
                headers: { Cookie: backend!.identities.member.cookieHeader },
                signal: AbortSignal.any([
                  AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
                  ...(options.signal ? [options.signal] : []),
                ]),
              });
              if (response.status === 404) return false; // Next can bind before its dev routes are registered.
              if (!response.ok)
                throw new Error(`auth: BFF get-session returned ${response.status}`);
              const session = (await response.json()) as { user?: { id: string } };
              if (session.user?.id !== backend!.identities.member.userId)
                throw new Error("auth: BFF did not resolve the member fixture");
              return true;
            } catch (error) {
              if (
                error instanceof TypeError ||
                (error instanceof Error && error.name === "TimeoutError")
              )
                return false;
              throw error;
            }
          },
          120_000
        );
        webReadyAtMs = Date.now();
        break;
      } catch (error) {
        // If cleanup also fails, retain the startup cause and let the outer owner finish cleanup.
        try {
          if (next) await stopChild(next);
          await backend?.close();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Preview startup and cleanup failed");
        }
        backend = undefined;
        if (log) await new Promise<void>((resolve) => log!.end(resolve));
        log = undefined;
        const webLog = await readWebLog();
        const portCollision =
          (error as NodeJS.ErrnoException).code === "EADDRINUSE" || webLog.includes("EADDRINUSE");
        if (!portCollision || attempt === 2) throw error;
      }
    }
    if (!backend || !next) throw new Error("web: no startup attempt succeeded");
    stage("auth");
    for (const path of ["/api/me/authorization", "/api/repos", "/api/sessions"]) {
      const response = await fetch(`${webOrigin}${path}`, {
        headers: { Cookie: backend.identities.member.cookieHeader },
        signal: AbortSignal.any([
          AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
      if (!response.ok) throw new Error(`auth: ${path} returned ${response.status}`);
    }
    signInLinks = await startSignInLinks(webOrigin, backend.signIn);
    secrets.add(signInLinks.key);
    const personas = {} as PreviewManifest["personas"];
    for (const persona of PERSONAS) {
      const identity = backend.identities[persona];
      const statePath = join(runDir, `${persona}.json`);
      await writeFile(statePath, JSON.stringify(identity.storageState), { mode: 0o600 });
      personas[persona] = {
        userId: identity.userId,
        statePath,
        browserSession: `oi-preview-${runId}-${persona}`,
        expiresAtMs: identity.expiresAtMs,
      };
    }
    const manifest: PreviewManifest = {
      schemaVersion: 1,
      runId,
      pid: process.pid,
      root,
      sourceRevision,
      dirty,
      scenario: options.scenario ?? "populated",
      fixtureSchemaVersion: 1,
      webOrigin,
      controlPlaneOrigin: backend.origin,
      startedAtMs,
      expiresAtMs: startedAtMs + PREVIEW_LIFETIME_MS,
      aliases: backend.aliases,
      personas,
      logs: { web: join(runDir, "web.log") },
      checks: ["real-bff-member", "repos", "sessions", "no-interactive-browser"],
      status: "ready",
      timings: {
        backendMs,
        webReadyMs: webReadyAtMs - startedAtMs - backendMs,
        totalMs: Date.now() - startedAtMs,
      },
    };
    const manifestPath = join(runDir, "run.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    let reportFailure!: (error: Error) => void;
    const failure = new Promise<Error>((resolve) => {
      reportFailure = resolve;
    });
    // Only failures before an intentional close count; closing stops Next and the fixtures itself.
    const checkFailures = () => {
      if (closing) return;
      if (nextError) reportFailure(nextError);
      if (backend!.failures().length)
        reportFailure(new Error(`fixture: ${backend!.failures().join(", ")}`));
    };
    monitor = setInterval(checkFailures, 1000);
    // Next's exit is reported at once, not at the next tick, so no check can pass in between.
    next.once("exit", checkFailures);
    lifetime = setTimeout(
      () => reportFailure(new Error("preview: four-hour run expired; start a new run")),
      PREVIEW_LIFETIME_MS - (Date.now() - startedAtMs)
    );
    return {
      manifest,
      manifestPath,
      backend,
      signInLinks: signInLinks.urls,
      failure,
      close,
      recordFailure,
    };
  } catch (error) {
    recordedFailures.push(error);
    let failure = error;
    try {
      await close();
    } catch (cleanupError) {
      failure = new AggregateError([error, cleanupError], "Preview startup and cleanup failed");
    }
    throw new Error(
      `${error instanceof Error ? error.message : "Preview startup failed"}; sanitized diagnostic: ${diagnosticPath}`,
      { cause: failure }
    );
  }
}
