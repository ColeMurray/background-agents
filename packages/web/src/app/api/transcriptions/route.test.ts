import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

import { getServerSession } from "next-auth";
import { POST } from "./route";

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

function transcriptionRequest(
  file = new File(["recording"], "prompt.webm", { type: "audio/webm" })
) {
  const formData = new FormData();
  formData.set("audio", file);
  return new Request("http://localhost/api/transcriptions", {
    method: "POST",
    body: formData,
  }) as NextRequest;
}

describe("transcriptions API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    process.env.OPENAI_API_KEY = "test-openai-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
  });

  it("rejects unauthenticated transcription requests", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await POST(transcriptionRequest());

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("transcribes a browser recording without submitting a prompt", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(fetch).mockResolvedValue(Response.json({ text: "Run npm test in packages/web." }));

    const response = await POST(transcriptionRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "Run npm test in packages/web." });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-openai-key" },
      })
    );
    const body = vi.mocked(fetch).mock.calls[0][1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("model")).toBe("gpt-4o-transcribe");
    expect((body as FormData).get("prompt")).toContain("Open-Inspect");
  });
});
