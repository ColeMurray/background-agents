import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { previewConfig } from "./config";
import { installGitHubFixture } from "./github-fixture";

describe("GitHub transport boundary", () => {
  it("keeps the caller's abort signal alive across the local forwarding boundary", async () => {
    const origin = "http://127.0.0.1:3100";
    const config = previewConfig(origin, origin, origin, "secret");
    const original = globalThis.fetch;
    const forward = vi.fn<typeof fetch>(async () => Response.json({}));
    globalThis.fetch = forward;
    const fixture = installGitHubFixture({
      origins: [origin],
      appId: config.GITHUB_APP_ID!,
      installationId: config.GITHUB_APP_INSTALLATION_ID!,
      privateKey: config.GITHUB_APP_PRIVATE_KEY!,
      token: "fixture-token",
    });
    try {
      const controller = new AbortController();
      await fetch(origin, { signal: controller.signal });
      const request = new Request(origin, { signal: controller.signal });
      await fetch(request);
      // Keeping the original signal, rather than only a Request clone's dependent signal,
      // is required for Node's timeout lifetime. The real seeding test checks the deadline.
      expect(forward.mock.calls[0][1]?.signal).toBe(controller.signal);
      expect(forward.mock.calls[1][1]?.signal).toBe(request.signal);
    } finally {
      fixture.close();
      globalThis.fetch = original;
    }
  });
  it("rejects unknown Request inputs and redirects without contacting the destination", async () => {
    const server = createServer((_, response) => {
      response.writeHead(302, { Location: "https://example.com/leak" });
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = previewConfig(origin, origin, origin, "secret");
    const fixture = installGitHubFixture({
      origins: [origin],
      appId: config.GITHUB_APP_ID!,
      installationId: config.GITHUB_APP_INSTALLATION_ID!,
      privateKey: config.GITHUB_APP_PRIVATE_KEY!,
      token: "fixture-token",
    });
    try {
      await expect(fetch(new Request("https://example.com/leak"))).rejects.toThrow("unexpected");
      await expect(fetch("https://api.github.com/unknown")).rejects.toThrow("unexpected");
      await expect(fetch(origin)).rejects.toThrow();
      expect(fixture.unexpectedRequests).toEqual([
        "GET https://example.com/leak",
        "GET https://api.github.com/unknown",
        `GET ${origin}/`,
      ]);
    } finally {
      fixture.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
