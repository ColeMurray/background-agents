import { afterEach, describe, expect, it, vi } from "vitest";
import { firstPromptDelivery, type FirstPromptDelivery } from "./first-prompt-delivery";

const prompt: Parameters<FirstPromptDelivery["send"]>[1] = {
  content: "Fix the bug",
  model: "openai/gpt-5.4",
  reasoningEffort: "high",
  attachments: [{ attachmentId: "attachment-1", name: "screenshot.png" }],
};

describe("firstPromptDelivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the complete prompt payload through the real browser fetch boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(firstPromptDelivery.send("session-1", prompt)).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/sessions/session-1/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prompt),
      mode: "same-origin",
      credentials: "same-origin",
    });
  });

  it("parses forbidden reason codes and falls back for malformed denial bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "Forbidden", reason_code: "session_read_only" }, { status: 403 })
      )
      .mockResolvedValueOnce(Response.json({ error: "Forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(new Response("not JSON", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const message of [
      "Failed to send prompt (session_read_only)",
      "Failed to send prompt",
      "Failed to send prompt",
    ]) {
      await expect(firstPromptDelivery.send("session-1", prompt)).resolves.toEqual({
        ok: false,
        message,
        forbidden: true,
      });
    }
  });

  it("returns ordinary server errors or the fallback and propagates network failures", async () => {
    const offline = new Error("Offline");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Session unavailable" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({}, { status: 500 }))
      .mockRejectedValueOnce(offline);
    vi.stubGlobal("fetch", fetchMock);

    await expect(firstPromptDelivery.send("session-1", prompt)).resolves.toEqual({
      ok: false,
      message: "Session unavailable",
      forbidden: false,
    });
    await expect(firstPromptDelivery.send("session-1", prompt)).resolves.toEqual({
      ok: false,
      message: "Failed to send prompt",
      forbidden: false,
    });
    await expect(firstPromptDelivery.send("session-1", prompt)).rejects.toBe(offline);
  });
});
