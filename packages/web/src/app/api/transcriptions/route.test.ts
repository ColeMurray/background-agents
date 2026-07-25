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
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn());
    process.env.OPENAI_API_KEY = "test-openai-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it.each([
    {
      name: "exhausted quota",
      providerStatus: 429,
      providerBody: {
        error: {
          code: "insufficient_quota",
          type: "insufficient_quota",
          message: "You exceeded your current quota.",
        },
      },
      expectedStatus: 503,
      expectedBody: {
        code: "openai_quota_exhausted",
        error:
          "OpenAI voice transcription has no available API credit. Add billing or increase the project budget, then try again.",
      },
    },
    {
      name: "temporary rate limit",
      providerStatus: 429,
      providerBody: {
        error: {
          code: "rate_limit_exceeded",
          type: "requests",
          message: "Rate limit reached.",
        },
      },
      expectedStatus: 429,
      expectedBody: {
        code: "openai_rate_limited",
        error: "OpenAI is rate-limiting voice transcription. Wait a moment and try again.",
      },
    },
    {
      name: "invalid credentials",
      providerStatus: 401,
      providerBody: {
        error: {
          code: "invalid_api_key",
          type: "invalid_request_error",
          message: "Incorrect API key provided.",
        },
      },
      expectedStatus: 503,
      expectedBody: {
        code: "openai_authentication_failed",
        error: "Voice input credentials need administrator attention.",
      },
    },
    {
      name: "unclassified provider failure",
      providerStatus: 400,
      providerBody: {
        error: {
          code: "unexpected_provider_code",
          type: "invalid_request_error",
          message: "Sensitive provider detail.",
        },
      },
      expectedStatus: 502,
      expectedBody: {
        code: "transcription_provider_failed",
        error: "Failed to transcribe recording",
      },
    },
  ])(
    "returns a safe, actionable message for $name",
    async ({ providerStatus, providerBody, expectedStatus, expectedBody }) => {
      vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
      vi.mocked(fetch).mockResolvedValue(Response.json(providerBody, { status: providerStatus }));

      const response = await POST(transcriptionRequest());

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toEqual(expectedBody);
      expect(JSON.stringify(expectedBody)).not.toContain(providerBody.error.message);
    }
  );
});
