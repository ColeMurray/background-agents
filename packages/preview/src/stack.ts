import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPreviewBackend, unusedPort, type PreviewBackend } from "./backend";
import { Cleanup } from "./cleanup";
import { PREVIEW_LIFETIME_MS, previewRequestSignal } from "./config";
import { readLogTail, sanitizedDiagnostic } from "./diagnostics";
import { startNext, webEnvFileKeys, webEnvironment } from "./next";
import { isProcessAlive, waitFor } from "./process";
import { PERSONAS, type Persona, type PreviewReady, type Scenario, type TeamsMode } from "./ready";
import { startSignInLinks } from "./sign-in-links";

const WEB_READY_TIMEOUT_MS = 120_000;
/** Pages a first visit opens, compiled during startup so no browser waits on Next's compiler. */
const WARM_PAGES = ["/", `/session/${"0".repeat(32)}`];

interface PreviewStackOptions {
  root: string;
  scenario?: Scenario;
  teamsEnforcement?: TeamsMode;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

export interface PreviewStack {
  /** The ready line, less what only the CLI knows. */
  ready: Omit<PreviewReady, "status" | "browserSession">;
  backend: PreviewBackend;
  /** The first failure while the stack runs: Next exiting, a fixture failure or run expiry. */
  failure: Promise<Error>;
  close(): Promise<void>;
  /** Adds a failure to the sanitized diagnostic and returns the diagnostic's path. */
  recordFailure(error: unknown): Promise<string>;
}

/** One Next process per checkout. Never attaches to or kills an unrelated process. */
export async function startPreviewStack(options: PreviewStackOptions): Promise<PreviewStack> {
  const root = resolve(options.root);
  const scenario = options.scenario ?? "populated";
  const teamsEnforcement = options.teamsEnforcement ?? "on";
  const startedAtMs = Date.now();
  const stage = (name: string) => {
    options.signal?.throwIfAborted();
    options.onStage?.(name);
  };
  stage("preflight");
  const workDir = join(root, ".preview");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const lockPath = join(workDir, "lock.json");
  await acquireCheckoutLock(lockPath);

  const cleanup = new Cleanup();
  cleanup.defer(() => rm(lockPath));
  const secrets = new Set<string>();
  const failures: unknown[] = [];
  const diagnosticPath = join(workDir, "last-failure.log");
  let webLogPath: string | undefined;
  let finalWebLog = "";
  const writeDiagnostic = (webLog: string) =>
    writeFile(
      diagnosticPath,
      sanitizedDiagnostic(new AggregateError(failures, "Preview failed"), webLog, secrets),
      { mode: 0o600 }
    );
  const recordFailure = async (error: unknown) => {
    failures.push(error);
    await writeDiagnostic(webLogPath ? await readLogTail(webLogPath) : "");
    return diagnosticPath;
  };
  let monitor: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(monitor);
      clearTimeout(lifetime);
      const errors = await cleanup.run();
      // Last, so the retained diagnostic includes failures of the releases too.
      failures.push(...errors);
      if (failures.length) await writeDiagnostic(finalWebLog).catch((error) => errors.push(error));
      if (errors.length)
        throw new AggregateError(
          errors,
          `shutdown: preview did not close cleanly; sanitized diagnostic: ${diagnosticPath}`
        );
    })());
  try {
    const runDir = await mkdtemp(join(tmpdir(), "oi-preview-"));
    cleanup.defer(() => rm(runDir, { recursive: true, force: true }));
    const logPath = join(runDir, "web.log");
    webLogPath = logPath;
    // Runs just before the removal above, so the diagnostic keeps the log's tail.
    cleanup.defer(async () => {
      finalWebLog = await readLogTail(logPath);
    });

    stage("control-plane");
    const webPort = await unusedPort();
    const webOrigin = `http://127.0.0.1:${webPort}`;
    const backend = await startPreviewBackend({
      root,
      runDir,
      webOrigin,
      scenario,
      teamsEnforcement,
      signal: options.signal,
    });
    cleanup.defer(() => backend.close());
    for (const [key, value] of Object.entries(backend.config))
      if (/SECRET|KEY|TOKEN/.test(key) && value) secrets.add(value);
    for (const { cookieHeader } of Object.values(backend.identities)) {
      secrets.add(cookieHeader);
      secrets.add(cookieHeader.slice(cookieHeader.indexOf("=") + 1));
    }

    stage("web");
    const next = startNext({
      root,
      port: webPort,
      logPath,
      env: webEnvironment(
        process.env,
        backend.config,
        await webEnvFileKeys(join(root, "packages/web"))
      ),
    });
    cleanup.defer(() => next.stop());
    const member = backend.identities.member;
    const get = (path: string, timeoutMs?: number) =>
      fetch(`${webOrigin}${path}`, {
        headers: { Cookie: member.cookieHeader },
        signal: previewRequestSignal(options.signal, timeoutMs),
      });
    await waitFor(
      "Next and authenticated BFF (inspect web.log for compile errors)",
      async () => {
        options.signal?.throwIfAborted();
        if (next.failure) throw next.failure;
        let response: Response;
        try {
          response = await get("/api/auth/get-session");
        } catch (error) {
          // Until Next responds, a refusal or a slow first compile is expected.
          if (
            error instanceof TypeError ||
            (error instanceof Error && error.name === "TimeoutError")
          )
            return false;
          throw error;
        }
        if (response.status === 404) return false; // Next can bind before its dev routes are registered.
        if (!response.ok) throw new Error(`auth: BFF get-session returned ${response.status}`);
        const session = (await response.json()) as { user?: { id: string } } | null;
        if (session?.user?.id !== member.userId)
          throw new Error("auth: BFF did not resolve the member fixture");
        return true;
      },
      WEB_READY_TIMEOUT_MS
    );

    stage("auth");
    for (const path of ["/api/me/authorization", "/api/repos", "/api/sessions"]) {
      const response = await get(path);
      if (!response.ok) throw new Error(`auth: ${path} returned ${response.status}`);
    }
    for (const path of WARM_PAGES) await (await get(path, WEB_READY_TIMEOUT_MS)).arrayBuffer();

    const signInLinks = await startSignInLinks(webOrigin, backend.signIn);
    cleanup.defer(() => signInLinks.close());
    secrets.add(signInLinks.key);

    const expiresAtMs = startedAtMs + PREVIEW_LIFETIME_MS;
    let reportFailure!: (error: Error) => void;
    const failure = new Promise<Error>((resolve) => {
      reportFailure = resolve;
    });
    // Only failures before an intentional close count; closing stops Next and the fixtures itself.
    const checkFailures = () => {
      if (closing) return;
      if (next.failure) reportFailure(next.failure);
      const fixtureFailures = backend.failures();
      if (fixtureFailures.length)
        reportFailure(new Error(`fixture: ${fixtureFailures.join(", ")}`));
    };
    monitor = setInterval(checkFailures, 1000);
    // Next's exit is reported at once, not at the next tick, so no check can pass in between.
    void next.exited.then(checkFailures);
    lifetime = setTimeout(
      () => reportFailure(new Error("preview: four-hour run expired; start a new run")),
      expiresAtMs - Date.now()
    );
    return {
      ready: {
        pid: process.pid,
        webOrigin,
        controlPlaneOrigin: backend.origin,
        modalOrigin: backend.modal.origin,
        runDir,
        logs: { web: logPath },
        scenario,
        teamsEnforcement,
        expiresAtMs,
        aliases: backend.aliases,
        userIds: Object.fromEntries(
          PERSONAS.map((persona) => [persona, backend.identities[persona].userId])
        ) as Record<Persona, string | null>,
        signInLinks: signInLinks.urls,
      },
      backend,
      failure,
      close,
      recordFailure,
    };
  } catch (error) {
    failures.push(error);
    let cause = error;
    try {
      await close();
    } catch (cleanupError) {
      cause = new AggregateError([error, cleanupError], "Preview startup and cleanup failed");
    }
    throw new Error(
      `${error instanceof Error ? error.message : "Preview startup failed"}; sanitized diagnostic: ${diagnosticPath}`,
      { cause }
    );
  }
}

/** Takes the checkout for this process. A lock whose recorded process has exited is taken over. */
async function acquireCheckoutLock(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let owner: unknown;
    try {
      owner = (JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid;
    } catch {
      // Unreadable or still being written: treat it as owned.
    }
    if (attempt > 0 || !Number.isInteger(owner) || isProcessAlive(owner as number))
      throw new Error(
        `preflight: checkout already owned; inspect ${path}. Stop its preview before starting another.`
      );
    await rm(path, { force: true }); // Left by a preview that was killed.
  }
}
