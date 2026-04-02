// Local dev shim for @cloudflare/sandbox
// The real module is only available on the Cloudflare platform.
import { DurableObject } from "cloudflare:workers";

export class Sandbox extends DurableObject {}
export { Sandbox as SandboxContainer };
export function getSandbox() {
  throw new Error("Sandbox SDK not available in local dev");
}
