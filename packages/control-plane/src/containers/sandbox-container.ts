/**
 * Sandbox container — re-exports from @cloudflare/sandbox SDK.
 *
 * The SDK's Sandbox class extends Container and handles container lifecycle
 * (start, sleep, destroy) automatically. Cloudflare Workers discovers it as
 * a Durable Object via the export in index.ts.
 */

// Re-export Sandbox as SandboxContainer for the DO binding
export { Sandbox as SandboxContainer } from "@cloudflare/sandbox";

// Re-export getSandbox for the provider to obtain instances
export { getSandbox } from "@cloudflare/sandbox";
