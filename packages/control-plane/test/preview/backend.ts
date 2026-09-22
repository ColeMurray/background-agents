import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { GLOBAL_STORE_FILE, startNodeHost, type NodeHost } from "../../src/node/host";
import { openNodeSqlDatabase } from "../../src/node/sqlite-database";
import { SANDBOX_RUNTIME_VERSION } from "../../src/sandbox/runtime-manifest";
import { readNodeHostSettings } from "../../src/node/config";
import { startFakeModalServer, type FakeModalServer } from "../smoke/fake-modal-server.mjs";
import { previewConfig, PREVIEW_REPLY, PREVIEW_REQUEST_TIMEOUT_MS, randomSecret } from "./config";
import { installGitHubFixture } from "./github-fixture";
import { createPreviewObjectStorage } from "./object-storage";
import { seedPersonas } from "./personas";
import { populateScenario, type PreviewRequest, type Scenario } from "./scenarios";

export async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

/** Runs the unchanged route catalog, migrations, scheduler and session graph. One per process. */
export async function startPreviewBackend(options: {
  root: string;
  runDir: string;
  webOrigin: string;
  scenario: Scenario;
  port?: number;
  inactivityTimeoutMs?: number;
  signal?: AbortSignal;
}) {
  const port = options.port ?? (await unusedPort());
  const origin = `http://127.0.0.1:${port}`;
  let modal: FakeModalServer | undefined;
  let fixture: ReturnType<typeof installGitHubFixture> | undefined;
  let host: NodeHost | undefined;
  const failures = () => [
    ...(fixture?.unexpectedRequests ?? []),
    ...(modal?.state.unexpectedRequests ?? []),
    ...(modal?.state.errors ?? []),
  ];
  let stopped: Promise<void> | undefined;
  const close = () =>
    (stopped ??= (async () => {
      const errors: unknown[] = [];
      try {
        const report = await host?.shutdown();
        if (report && !report.clean)
          errors.push(new Error(`shutdown: abandoned ${report.abandoned.join(", ")}`));
      } catch (error) {
        errors.push(error);
      }
      try {
        await modal?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        fixture?.close();
      } catch (error) {
        errors.push(error);
      }
      if (failures().length) errors.push(new Error(`fixture: ${failures().join(", ")}`));
      if (errors.length) throw new AggregateError(errors, "Preview backend did not close cleanly");
    })());
  try {
    const modalSecret = randomSecret();
    modal = await startFakeModalServer({
      secret: modalSecret,
      reply: PREVIEW_REPLY,
      runtimeVersion: SANDBOX_RUNTIME_VERSION,
    });
    const config = previewConfig(options.webOrigin, origin, modal.origin, modalSecret);
    if (options.inactivityTimeoutMs !== undefined)
      config.SANDBOX_INACTIVITY_TIMEOUT_MS = String(options.inactivityTimeoutMs);
    fixture = installGitHubFixture({
      origins: [origin, options.webOrigin, modal.origin],
      appId: config.GITHUB_APP_ID!,
      installationId: config.GITHUB_APP_INSTALLATION_ID!,
      privateKey: config.GITHUB_APP_PRIVATE_KEY!,
      token: randomSecret(),
    });
    const dataDir = join(options.runDir, "data");
    await mkdir(dataDir, { mode: 0o700 });
    const migrationsDir = join(options.root, "terraform/d1/migrations");
    const seedDb = openNodeSqlDatabase(join(dataDir, GLOBAL_STORE_FILE), { migrationsDir });
    const identities = await (async () => {
      try {
        return await seedPersonas(seedDb, options.webOrigin, config.BROWSER_AUTH_SECRET!);
      } finally {
        seedDb.close();
      }
    })();
    host = await startNodeHost({
      config,
      objectStorage: createPreviewObjectStorage(),
      settings: readNodeHostSettings({
        PORT: String(port),
        HOST: "127.0.0.1",
        DATA_DIR: dataDir,
        MIGRATIONS_DIR: migrationsDir,
      }),
    });
    const request: PreviewRequest = async (path, init) => {
      const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
      const method = init?.method ?? "GET";
      const url = `${origin}${path}`;
      return fetch(url, {
        method,
        body,
        signal: AbortSignal.any([
          AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
          ...(options.signal ? [options.signal] : []),
        ]),
        headers: {
          ...(await buildServiceAuthHeaders({
            service: "web",
            secret: config.SERVICE_AUTH_SECRET_WEB!,
            url,
            method,
            body,
          })),
          Cookie: identities[init?.persona ?? "member"].cookieHeader,
          ...(body ? { "content-type": "application/json", Origin: options.webOrigin } : {}),
        },
      });
    };
    const aliases = await populateScenario(options.scenario, request);
    if (failures().length) throw new Error(`fixture: ${failures().join(", ")}`);
    return { origin, config, identities, aliases, request, modal, fixture, failures, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Backend startup and cleanup failed");
    }
    throw error;
  }
}

export type PreviewBackend = Awaited<ReturnType<typeof startPreviewBackend>>;
