import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const VOCABULARY_PROMPT =
  "Open-Inspect, useSessionSocket, requestId, TypeScript, Vitest, Daytona, Cloudflare, Next.js, npm";
const transcriptionResponseSchema = z.object({ text: z.string() });
const openAiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().nullable().optional(),
    type: z.string().optional(),
  }),
});

type TranscriptionErrorCode =
  | "openai_quota_exhausted"
  | "openai_rate_limited"
  | "openai_authentication_failed"
  | "transcription_provider_failed";

type ClassifiedTranscriptionError = {
  code: TranscriptionErrorCode;
  message: string;
  status: number;
  providerCode: string | null;
  providerType: string | null;
};

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Voice input is not configured" }, { status: 503 });
  }

  try {
    const requestBody = await request.formData();
    const audio = requestBody.get("audio");
    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json({ error: "An audio recording is required" }, { status: 400 });
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        { error: "Audio recording exceeds the 25 MB limit" },
        { status: 413 }
      );
    }

    const openAiBody = new FormData();
    openAiBody.set("file", audio);
    openAiBody.set("model", TRANSCRIPTION_MODEL);
    openAiBody.set("prompt", VOCABULARY_PROMPT);

    const response = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: openAiBody,
      signal: request.signal,
    });
    if (!response.ok) {
      const failure = await classifyOpenAiTranscriptionError(response);
      console.error("OpenAI transcription failed", {
        status: response.status,
        code: failure.providerCode,
        type: failure.providerType,
        classification: failure.code,
      });
      return NextResponse.json(
        { error: failure.message, code: failure.code },
        { status: failure.status }
      );
    }

    const parsed = transcriptionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error("OpenAI transcription returned an invalid response", parsed.error);
      return NextResponse.json({ error: "Failed to transcribe recording" }, { status: 502 });
    }

    return NextResponse.json({ text: parsed.data.text });
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: "Transcription cancelled" }, { status: 499 });
    }
    console.error("Failed to transcribe recording:", error);
    return NextResponse.json({ error: "Failed to transcribe recording" }, { status: 500 });
  }
}

async function classifyOpenAiTranscriptionError(
  response: Response
): Promise<ClassifiedTranscriptionError> {
  const parsed = openAiErrorResponseSchema.safeParse(await readJson(response));
  const providerCode = parsed.success ? (parsed.data.error.code ?? null) : null;
  const providerType = parsed.success ? (parsed.data.error.type ?? null) : null;

  if (providerCode === "insufficient_quota") {
    return {
      code: "openai_quota_exhausted",
      message:
        "OpenAI voice transcription has no available API credit. Add billing or increase the project budget, then try again.",
      status: 503,
      providerCode,
      providerType,
    };
  }

  if (providerCode === "invalid_api_key" || response.status === 401 || response.status === 403) {
    return {
      code: "openai_authentication_failed",
      message: "Voice input credentials need administrator attention.",
      status: 503,
      providerCode,
      providerType,
    };
  }

  if (response.status === 429) {
    return {
      code: "openai_rate_limited",
      message: "OpenAI is rate-limiting voice transcription. Wait a moment and try again.",
      status: 429,
      providerCode,
      providerType,
    };
  }

  return {
    code: "transcription_provider_failed",
    message: "Failed to transcribe recording",
    status: 502,
    providerCode,
    providerType,
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
