/**
 * Stub for @cloudflare/containers used during integration tests.
 *
 * The real module is provided by the workerd runtime at deploy time.
 * Miniflare (used by @cloudflare/vitest-pool-workers) does not bundle
 * this module, so we provide a minimal stub so that Vite can resolve
 * the import without errors.
 */
export class Container {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
