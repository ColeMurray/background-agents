import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PERSONAL_ACCESS_TOKEN_PREFIX } from "@open-inspect/shared/types/personal-access-tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "./client";
import { createServer } from "./index";

const TOKEN = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"a".repeat(64)}`;
const BASE_URL = "https://control-plane.example.com";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session diff responses", () => {
  it("returns the exact raw patch through MCP using the real control-plane client", async () => {
    const patch =
      'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+"caf\u00e9" \\ path  \n';
    const fetchMock = vi.fn(
      async () => new Response(patch, { headers: { "Content-Type": "text/x-diff; charset=utf-8" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "0" });
    const server = createServer(new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }));

    try {
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      const result = await mcpClient.callTool({
        name: "get_session_diff_file",
        arguments: { session_id: "session/1", revision_id: "rev 1", file_id: "file/../2" },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: patch }]);
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/sessions/session%2F1/diff/rev%201/files/file%2F..%2F2`,
        expect.objectContaining({
          method: "GET",
          redirect: "error",
          headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
          signal: expect.any(AbortSignal),
        })
      );
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it("still parses JSON GET and POST responses", async () => {
    const body = { current: { revisionId: "rev_1" } };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.get("/sessions/s1/diff")).resolves.toEqual(body);
    await expect(client.post("/automations", {})).resolves.toEqual(body);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({ Accept: "application/json" });
    }
  });

  it("preserves JSON permission errors on text requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code: "permission_required", permission: "sessions.read" }, { status: 403 })
      )
    );
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.getText("/sessions/s1/diff/r1/files/f1")).rejects.toMatchObject({
      name: "ControlPlaneError",
      status: 403,
      message: expect.stringContaining("This token was not granted sessions.read"),
    });
  });

  it("caps text responses and cancels the oversized stream", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
              },
              cancel,
            })
          )
      )
    );
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.getText("/sessions/s1/diff/r1/files/f1")).rejects.toMatchObject({
      name: "ControlPlaneError",
      status: 200,
      message: expect.stringContaining("exceeded 8388608 bytes"),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps the timeout active while reading a text body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("diff --git"));
                init?.signal?.addEventListener("abort", () =>
                  controller.error(new Error("aborted"))
                );
              },
            })
          )
      )
    );
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN, timeoutMs: 50 });

    await expect(client.getText("/sessions/s1/diff/r1/files/f1")).rejects.toThrow(
      "timed out after 50ms"
    );
  });
});
