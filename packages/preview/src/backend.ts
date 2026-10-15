import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { GLOBAL_STORE_FILE, startNodeHost } from "@open-inspect/control-plane/src/node/host";
import { openNodeSqlDatabase } from "@open-inspect/control-plane/src/node/sqlite-database";
import { SANDBOX_RUNTIME_VERSION } from "@open-inspect/control-plane/src/sandbox/runtime-manifest";
import { readNodeHostSettings } from "@open-inspect/control-plane/src/node/config";
import {
  startFakeModalServer,
  type FakeModalServer,
} from "@open-inspect/control-plane/test/smoke/fake-modal-server.mjs";
import { Cleanup } from "./cleanup";
import { previewConfig, previewRequestSignal, randomSecret } from "./config";
import { installGitHubFixture } from "./github-fixture";
import { createPreviewObjectStorage } from "./object-storage";
import { seedPersonas, signInPersona } from "./personas";
import { PREVIEW_REPLY, type Persona, type Scenario, type TeamsMode } from "./ready";
import { populateScenario, type PreviewRequest } from "./scenarios";

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
  teamsEnforcement: TeamsMode;
  inactivityTimeoutMs?: number;
  signal?: AbortSignal;
}) {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const cleanup = new Cleanup();
  let modal: FakeModalServer | undefined;
  let fixture: ReturnType<typeof installGitHubFixture> | undefined;
  const failures = () => [
    ...(fixture?.unexpectedRequests ?? []),
    ...(modal?.state.unexpectedRequests ?? []),
    ...(modal?.state.errors ?? []),
  ];
  let stopped: Promise<void> | undefined;
  const close = () =>
    (stopped ??= (async () => {
      const errors = await cleanup.run();
      if (failures().length) errors.push(new Error(`fixture: ${failures().join(", ")}`));
      if (errors.length) throw new AggregateError(errors, "Preview backend did not close cleanly");
    })());
  try {
    const modalSecret = randomSecret();
    const modalServer = await startFakeModalServer({
      secret: modalSecret,
      reply: PREVIEW_REPLY,
      runtimeVersion: SANDBOX_RUNTIME_VERSION,
    });
    modal = modalServer;
    cleanup.defer(() => modalServer.close());
    const config = previewConfig({
      webOrigin: options.webOrigin,
      controlPlaneOrigin: origin,
      modalOrigin: modalServer.origin,
      modalSecret,
      teamsEnforcement: options.teamsEnforcement,
    });
    if (options.inactivityTimeoutMs !== undefined)
      config.SANDBOX_INACTIVITY_TIMEOUT_MS = String(options.inactivityTimeoutMs);
    const githubFixture = installGitHubFixture({
      origins: [origin, options.webOrigin, modalServer.origin],
      appId: config.GITHUB_APP_ID!,
      installationId: config.GITHUB_APP_INSTALLATION_ID!,
      privateKey: config.GITHUB_APP_PRIVATE_KEY!,
      token: randomSecret(),
    });
    fixture = githubFixture;
    cleanup.defer(() => githubFixture.close());

    const dataDir = join(options.runDir, "data");
    await mkdir(dataDir, { mode: 0o700 });
    const migrationsDir = join(options.root, "terraform/d1/migrations");
    const globalStore = join(dataDir, GLOBAL_STORE_FILE);
    const seedDb = openNodeSqlDatabase(globalStore, { migrationsDir });
    let identities: Awaited<ReturnType<typeof seedPersonas>>;
    try {
      identities = await seedPersonas(seedDb, options.webOrigin, config.BROWSER_AUTH_SECRET!);
    } finally {
      seedDb.close();
    }
    const host = await startNodeHost({
      config,
      objectStorage: createPreviewObjectStorage(),
      settings: readNodeHostSettings({
        PORT: String(port),
        HOST: "127.0.0.1",
        DATA_DIR: dataDir,
        MIGRATIONS_DIR: migrationsDir,
      }),
    });
    cleanup.defer(async () => {
      const report = await host.shutdown();
      if (!report.clean) throw new Error(`shutdown: abandoned ${report.abandoned.join(", ")}`);
    });

    const request: PreviewRequest = async (path, init) => {
      const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
      const method = init?.method ?? "GET";
      const url = `${origin}${path}`;
      return fetch(url, {
        method,
        body,
        signal: previewRequestSignal(options.signal),
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
    // A second connection beside the running host's: the store is WAL with a busy timeout.
    const signIn = async (persona: Persona) => {
      const db = openNodeSqlDatabase(globalStore);
      try {
        return await signInPersona(
          db,
          options.webOrigin,
          config.BROWSER_AUTH_SECRET!,
          identities[persona]
        );
      } finally {
        db.close();
      }
    };
    const aliases = await populateScenario(options.scenario, request);
    if (failures().length) throw new Error(`fixture: ${failures().join(", ")}`);
    return {
      origin,
      config,
      identities,
      aliases,
      request,
      signIn,
      modal: modalServer,
      failures,
      close,
    };
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
