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
import { createDurableObjectPiRuntimeDispatch } from "./pi-runtime-dispatch";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type { PiSessionDO } from "./pi-durable-object";
import type { McpConnectionDO } from "./mcp-connection-durable-object";
import { createMcpConnectionBrokerDispatch } from "./mcp-connection-dispatch";
import { BrowserRenderingTransport } from "./browser-rendering-transport";

/** The bindings Cloudflare hands the Worker and its Durable Objects, with the deployment's configuration. */
export interface WorkerBindings extends EnvConfig, JobQueueBindings {
  SESSION: DurableObjectNamespace;
  PI_SESSION?: DurableObjectNamespace<PiSessionDO>;
  MCP_CONNECTION?: DurableObjectNamespace<McpConnectionDO>;
  /** External, separately deployed VM object. Never adapt this into the application Platform. */
  CODEMODE_SANDBOX?: DurableObjectNamespace<CodemodeSandboxDurableObject>;
  /** Optional isolate loader for the read-only Computer JavaScript backend. */
  WORKSPACE_LOADER?: WorkerLoader;
  REPOS_CACHE: KVNamespace;
  SLACK_BOT?: Fetcher;
  LINEAR_BOT?: Fetcher;
  AUTOFIX_DLQ?: Queue<unknown>;
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  /**
   * The Workers Browser Rendering binding.
   *
   * It is read by the session's browser gateway, which holds it as a port and
   * drives it only for a request it has authorized. Absent unless the
   * deployment stages it.
   */
  BROWSER?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
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
    PI_SESSION,
    MCP_CONNECTION,
    CODEMODE_SANDBOX: _CODEMODE_SANDBOX,
    WORKSPACE_LOADER: _WORKSPACE_LOADER,
    REPOS_CACHE,
    MEDIA_BUCKET,
    SLACK_BOT,
    LINEAR_BOT,
    AUTOFIX_QUEUE,
    AUTOFIX_DLQ,
    IMAGE_BUILD_FINALIZATION_QUEUE,
    BROWSER,
    ...config
  } = bindings;
  const platform: Platform = {
    DB,
    SESSION: createDurableObjectSessionRuntimeDispatch(SESSION),
    PI_SESSION: PI_SESSION ? createDurableObjectPiRuntimeDispatch(PI_SESSION) : undefined,
    MCP_CONNECTION: MCP_CONNECTION ? createMcpConnectionBrokerDispatch(MCP_CONNECTION) : undefined,
    REPOS_CACHE: createKvCacheStore(REPOS_CACHE),
    MEDIA_BUCKET: new R2ObjectStorage(MEDIA_BUCKET),
    SLACK_BOT,
    LINEAR_BOT,
    AUTOFIX_QUEUE,
    AUTOFIX_DLQ,
    JOBS: createQueueJobs({ IMAGE_BUILD_FINALIZATION_QUEUE, AUTOFIX_QUEUE }),
    // The browser stays behind the session's gateway: the port is what the
    // session's browser gateway drives, and the binding never reaches the
    // Pi Durable Object.
    BROWSER: BROWSER ? new BrowserRenderingTransport(BROWSER) : undefined,
  };
  return { ...config, ...platform };
}

// Every field of WorkerBindings is either a platform port (adapted above), a
// queue behind the jobs port, or configuration: a new binding that is none
// of these fails to compile here.
type _AssertExtends<A extends B, B> = A;
type _BindingsAreConfigOrPlatform = _AssertExtends<
  Exclude<
    keyof WorkerBindings,
    keyof Platform | keyof JobQueueBindings | "CODEMODE_SANDBOX" | "WORKSPACE_LOADER"
  >,
  keyof EnvConfig
>;
