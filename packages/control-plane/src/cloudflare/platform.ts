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
import { createCloudflareJobQueue } from "./job-queue";
import { R2ObjectStorage } from "./object-storage";
import { createDurableObjectSessionRuntimeDispatch } from "./session-runtime-dispatch";

/** The bindings Cloudflare hands the Worker and its Durable Objects, with the deployment's configuration. */
export interface WorkerBindings extends EnvConfig {
  SESSION: DurableObjectNamespace;
  REPOS_CACHE: KVNamespace;
  SLACK_BOT?: Fetcher;
  LINEAR_BOT?: Fetcher;
  AUTOFIX_QUEUE?: Queue<unknown>;
  AUTOFIX_DLQ?: Queue<unknown>;
  DB: D1Database;
  IMAGE_BUILD_FINALIZATION_QUEUE: Queue<ImageBuildFinalizationJob>;
  MEDIA_BUCKET: R2Bucket;
}

/**
 * The application environment over the Worker's bindings: every binding
 * taken off the record and put behind its port, the configuration passed
 * through as given. A binding this function does not name is refused at
 * compile time (below), so adding one is an explicit composition decision.
 */
export function createCloudflareEnv(bindings: WorkerBindings): Env {
  const {
    DB,
    SESSION,
    REPOS_CACHE,
    MEDIA_BUCKET,
    SLACK_BOT,
    LINEAR_BOT,
    AUTOFIX_QUEUE,
    AUTOFIX_DLQ,
    IMAGE_BUILD_FINALIZATION_QUEUE,
    ...config
  } = bindings;
  const platform: Platform = {
    DB,
    SESSION: createDurableObjectSessionRuntimeDispatch(SESSION),
    REPOS_CACHE: createKvCacheStore(REPOS_CACHE),
    MEDIA_BUCKET: new R2ObjectStorage(MEDIA_BUCKET),
    SLACK_BOT,
    LINEAR_BOT,
    AUTOFIX_QUEUE,
    AUTOFIX_DLQ,
    JOBS: createCloudflareJobQueue({ IMAGE_BUILD_FINALIZATION_QUEUE }),
  };
  return { ...config, ...platform };
}

/**
 * Bindings the composition above folds into a port named for the seam rather
 * than for the binding. Listed so the assertion below still refuses a binding
 * nobody composed.
 */
type FoldedBindings = "IMAGE_BUILD_FINALIZATION_QUEUE";

// Every field of WorkerBindings is a platform port (adapted above), one of the
// bindings folded into one, or configuration: a new binding that is none of
// those fails to compile here.
type _AssertExtends<A extends B, B> = A;
type _EveryBindingIsComposed = _AssertExtends<
  Exclude<keyof WorkerBindings, keyof Platform | FoldedBindings>,
  keyof EnvConfig
>;
