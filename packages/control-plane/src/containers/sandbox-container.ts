/**
 * Sandbox container — re-exports from @cloudflare/sandbox SDK.
 *
 * The SDK's Sandbox class extends Container and handles container lifecycle
 * (start, sleep, destroy) automatically. Cloudflare Workers discovers it as
 * a Durable Object via the export in index.ts.
 */

// Re-export Sandbox directly — class_name in wrangler must match exactly.
// The c3po project uses "Sandbox" everywhere and it works.
export { Sandbox } from "@cloudflare/sandbox";

// Re-export getSandbox for the provider
export { getSandbox } from "@cloudflare/sandbox";
