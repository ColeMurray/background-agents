import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;

  try {
    const body = await request.json();
    const { content, model } = body;

    if (!content) {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }

    const user = session.user;
    const userId = user.id || user.email || "anonymous";

    const response = await controlPlaneFetch(`/sessions/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        content,
        authorId: userId,
        source: "web",
        model,
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
