/**
 * Stub for @cloudflare/sandbox used during integration tests.
 *
 * The real module is provided by the workerd runtime at deploy time.
 * Miniflare (used by @cloudflare/vitest-pool-workers) does not bundle
 * this module, so we provide a minimal stub so that Vite can resolve
 * the import without errors.
 */
export class Sandbox {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export { Sandbox as SandboxContainer };

export function getSandbox() {
  throw new Error("Sandbox SDK not available in integration tests");
}
