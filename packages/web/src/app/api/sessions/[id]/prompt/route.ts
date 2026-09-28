import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import {
  BLANK_PROMPT_MESSAGE,
  isBlankPrompt,
  promptContentSchema,
  promptValidationError,
} from "@open-inspect/shared/types/prompts";
import { sessionAttachmentReferencesSchema } from "@open-inspect/shared/types/session-attachments";
import { z } from "zod";
import { controlPlaneUserFetch } from "@/lib/control-plane";

const promptRequestSchema = z
  .strictObject({
    content: promptContentSchema,
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: sessionAttachmentReferencesSchema.optional(),
  })
  .refine((prompt) => !isBlankPrompt(prompt), {
    message: BLANK_PROMPT_MESSAGE,
    path: ["content"],
  });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;

  try {
    const raw = await request.json();
    const parsed = promptRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(promptValidationError(parsed.error, raw), {
        status: 400,
      });
    }
    const { content, model, reasoningEffort, attachments } = parsed.data;

    // authorId is derived by the control plane from the Bearer principal and
    // is rejected in the body under strict enforcement.
    const response = await controlPlaneUserFetch(`/sessions/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        content,
        source: "web",
        model,
        reasoningEffort,
        attachments,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      console.error("Failed to send prompt:", errorBody);
      if (errorBody && typeof errorBody === "object" && !Array.isArray(errorBody)) {
        return NextResponse.json(errorBody, { status: response.status });
      }
      return NextResponse.json({ error: "Failed to send prompt" }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to send prompt:", error);
    return NextResponse.json({ error: "Failed to send prompt" }, { status: 500 });
  }
}
