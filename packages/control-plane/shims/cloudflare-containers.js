// Local dev shim for @cloudflare/containers
// The real module is only available on the Cloudflare platform.
// This shim allows wrangler dev to start — the SandboxContainer DO
// will be registered but won't actually start containers locally.

import { DurableObject } from "cloudflare:workers";

export class Container extends DurableObject {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = false;
  pingEndpoint = "/health";

  async startAndWaitForPorts(_opts) {
    throw new Error("Containers are not supported in local dev");
  }

  async getState() {
    return "stopped";
  }

  async destroy() {
    // no-op in local dev
  }
}
