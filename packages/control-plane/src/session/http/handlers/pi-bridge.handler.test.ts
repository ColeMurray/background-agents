import { describe, expect, it, vi } from "vitest";
import { PiBridgeHandler } from "./pi-bridge.handler";

function harness() {
  const pin = vi.fn(async () => []);
  const restore = vi.fn(() => [
    {
      repoOwner: "acme",
      repoName: "widgets",
      position: 0,
      baseBranch: "main",
      commitSha: "original-sha",
    },
  ]);
  const handler = new PiBridgeHandler({
    sessions: {
      getSession: () => ({ harness: "pi" }) as never,
      getSessionRepositories: () => [],
    },
    messages: { getProcessingMessage: () => null },
    credentials: { getOpenAIAccess: vi.fn() },
    skills: { getSandboxInstallation: vi.fn(async () => null) },
    repositories: {
      pin,
      restore,
      list: vi.fn(),
      read: vi.fn(),
    },
    getSessionId: () => "session-1",
  });
  return { handler, pin, restore };
}

describe("PiBridgeHandler context", () => {
  it("resolves repository heads only on the first context request", async () => {
    const h = harness();

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(200);
    expect(h.pin).toHaveBeenCalledOnce();
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("restores durable repository pins without resolving branch heads", async () => {
    const h = harness();
    const repositoryPins = [
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        commitSha: "original-sha",
      },
    ];

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryPins }),
      })
    );

    expect(response.status).toBe(200);
    expect(h.restore).toHaveBeenCalledWith(repositoryPins);
    expect(h.pin).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      repositories: [expect.objectContaining({ commitSha: "original-sha" })],
    });
  });
});
