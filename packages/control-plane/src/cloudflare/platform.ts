/**
 * The Worker's bindings and the platform ports built over them: where the
 * application meets Cloudflare's binding types. A binding whose type already
 * satisfies its port passes through unwrapped, so the assignments below are
 * also the compile-time proof that it does; a workers-types upgrade or a
 * port edit that breaks one fails typecheck here rather than at the stores.
 */

import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import type { Env, EnvConfig, Platform } from "../types";
import { createQueueJobs, type JobQueueBindings } from "./job-queue";
import { R2ObjectStorage } from "./object-storage";
import { createDurableObjectSessionRuntimeDispatch } from "./session-runtime-dispatch";

/** The bindings Cloudflare hands the Worker and its Durable Objects, with the deployment's configuration. */
export interface WorkerBindings extends EnvConfig, JobQueueBindings {
  SESSION: DurableObjectNamespace;
  REPOS_CACHE: KVNamespace;
  SLACK_KV?: KVNamespace;
  LINEAR_KV?: KVNamespace;
  GITHUB_KV?: KVNamespace;
  AUTOFIX_DLQ?: Queue<unknown>;
  DB: D1Database;
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
    SLACK_KV,
    LINEAR_KV,
    GITHUB_KV,
    MEDIA_BUCKET,
    AUTOFIX_QUEUE,
    SLACK_COMPLETION_QUEUE,
    LINEAR_COMPLETION_QUEUE,
    AUTOFIX_DLQ,
    IMAGE_BUILD_FINALIZATION_QUEUE,
    ...config
  } = bindings;
  const platform: Platform = {
    DB,
    SESSION: createDurableObjectSessionRuntimeDispatch(SESSION),
    REPOS_CACHE: createKvCacheStore(REPOS_CACHE),
    ...(SLACK_KV ? { SLACK_KV: createKvCacheStore(SLACK_KV) } : {}),
    ...(LINEAR_KV ? { LINEAR_KV: createKvCacheStore(LINEAR_KV) } : {}),
    ...(GITHUB_KV ? { GITHUB_KV: createKvCacheStore(GITHUB_KV) } : {}),
    MEDIA_BUCKET: new R2ObjectStorage(MEDIA_BUCKET),
    AUTOFIX_QUEUE,
    AUTOFIX_DLQ,
    JOBS: createQueueJobs({
      IMAGE_BUILD_FINALIZATION_QUEUE,
      AUTOFIX_QUEUE,
      SLACK_COMPLETION_QUEUE,
      LINEAR_COMPLETION_QUEUE,
    }),
  };
  return { ...config, ...platform };
}

// Every field of WorkerBindings is either a platform port (adapted above), a
// queue behind the jobs port, or configuration: a new binding that is none
// of these fails to compile here.
type _AssertExtends<A extends B, B> = A;
type _BindingsAreConfigOrPlatform = _AssertExtends<
  Exclude<keyof WorkerBindings, keyof Platform | keyof JobQueueBindings>,
  keyof EnvConfig
>;
