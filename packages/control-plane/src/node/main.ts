/**
 * The Node host's process entry: configuration from the environment, the
 * host started, and the process signals turned into an orderly shutdown.
 * Everything else is `host.ts`, so a test can boot the host in-process.
 */

import { createLogger, parseLogLevel } from "../logger";
import { readEnvConfig, readNodeHostSettings } from "./config";
import { startNodeHost } from "./host";
import { readS3ObjectStorageConfig } from "./s3-object-storage";

/** Past the drain budget, how much longer the process gets before it is forced down. */
const FORCE_EXIT_GRACE_MS = 5_000;

const log = createLogger("node-main", {}, parseLogLevel(process.env.LOG_LEVEL));

async function main(): Promise<void> {
  const settings = readNodeHostSettings(process.env);
  const config = readEnvConfig(process.env);
  const objectStorage = readS3ObjectStorageConfig(process.env);
  const host = await startNodeHost({ config, settings, objectStorage });

  const stop = (signal: NodeJS.Signals): void => {
    log.info("node_host.signal", { event: "node_host.signal", signal });
    // Unreferenced, so it never holds the process open: a clean shutdown
    // exits on its own, and one whose abandoned work keeps the event loop
    // alive is forced down here.
    setTimeout(() => {
      log.error("node_host.shutdown_forced", {
        event: "node_host.shutdown_forced",
        timeout_ms: settings.shutdownTimeoutMs + FORCE_EXIT_GRACE_MS,
      });
      process.exit(1);
    }, settings.shutdownTimeoutMs + FORCE_EXIT_GRACE_MS).unref();
    host.shutdown().catch((error: unknown) => {
      log.error("node_host.shutdown_failed", {
        event: "node_host.shutdown_failed",
        error: error instanceof Error ? error : String(error),
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  log.error("node_host.boot_failed", {
    event: "node_host.boot_failed",
    error: error instanceof Error ? error : String(error),
  });
  process.exit(1);
});
