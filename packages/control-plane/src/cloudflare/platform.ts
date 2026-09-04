/**
 * The Worker's bindings and the platform ports built over them: where the
 * application meets Cloudflare's binding types. A binding whose type already
 * satisfies its port passes through unwrapped, so the assignments below are
 * also the compile-time proof that it does; a workers-types upgrade or a
 * port edit that breaks one fails typecheck here rather than at the stores.
 */

import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import type { ImageBuildFinalizationJob } from "../image-builds/finalization-job";
import type { Env, EnvConfig, Platform } from "../types";
import { R2ObjectStorage } from "./object-storage";
import { createDurableObjectSessionRuntimeClient } from "./session-runtime-client";

/** The bindings Cloudflare hands the Worker and its Durable Objects, with the deployment's configuration. */
export interface WorkerBindings extends EnvConfig {
  SESSION: DurableObjectNamespace;
  REPOS_CACHE: KVNamespace;
  SLACK_BOT?: Fetcher;
  LINEAR_BOT?: Fetcher;
  AUTOFIX_QUEUE?: Queue<unknown>;
  AUTOFIX_DLQ?: Queue<unknown>;
  DB: D1Database;
  IMAGE_BUILD_FINALIZATION_QUEUE?: Queue<ImageBuildFinalizationJob>;
  MEDIA_BUCKET: R2Bucket;
}

/** The platform ports over the Worker's bindings. */
function createCloudflarePlatform(bindings: WorkerBindings): Platform {
  return {
    // eslint-disable-next-line no-restricted-syntax -- platform composition root: the binding becomes the port here
    DB: bindings.DB,
    SESSION: createDurableObjectSessionRuntimeClient(bindings.SESSION),
    REPOS_CACHE: createKvCacheStore(bindings.REPOS_CACHE),
    MEDIA_BUCKET: new R2ObjectStorage(bindings.MEDIA_BUCKET),
    SLACK_BOT: bindings.SLACK_BOT,
    LINEAR_BOT: bindings.LINEAR_BOT,
    AUTOFIX_QUEUE: bindings.AUTOFIX_QUEUE,
    AUTOFIX_DLQ: bindings.AUTOFIX_DLQ,
    IMAGE_BUILD_FINALIZATION_QUEUE: bindings.IMAGE_BUILD_FINALIZATION_QUEUE,
  };
}

/**
 * The application environment over the Worker's bindings: the configuration
 * as given, each binding behind its port.
 */
export function createCloudflareEnv(bindings: WorkerBindings): Env {
  return { ...bindings, ...createCloudflarePlatform(bindings) };
}
