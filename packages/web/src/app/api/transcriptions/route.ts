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
      console.error(`OpenAI transcription failed with status ${response.status}`);
      return NextResponse.json({ error: "Failed to transcribe recording" }, { status: 502 });
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
