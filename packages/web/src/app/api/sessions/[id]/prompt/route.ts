import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import {
  BLANK_PROMPT_MESSAGE,
  isBlankPrompt,
  promptContentSchema,
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
    const parsed = promptRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid prompt request" }, { status: 400 });
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
      const errorText = await response.text();
      console.error(`Failed to send prompt: ${errorText}`);
      return NextResponse.json({ error: "Failed to send prompt" }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to send prompt:", error);
    return NextResponse.json({ error: "Failed to send prompt" }, { status: 500 });
  }
}
