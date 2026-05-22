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

  const { id } = await params;
  const userId = session.user.id || session.user.email || "anonymous";

  // Explicitly pick allowed fields — the client may supply an
  // implementation model / reasoning effort but cannot override identity.
  let implementationModel: string | null | undefined = undefined;
  let implementationReasoningEffort: string | null | undefined = undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      implementationModel?: string | null;
      implementationReasoningEffort?: string | null;
    };
    implementationModel = body.implementationModel ?? undefined;
    implementationReasoningEffort = body.implementationReasoningEffort ?? undefined;
  } catch {
    // empty body is fine
  }

  try {
    const response = await controlPlaneFetch(`/sessions/${id}/plan/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approverAuthorId: `web:${userId}`,
        ...(implementationModel !== undefined ? { implementationModel } : {}),
        ...(implementationReasoningEffort !== undefined ? { implementationReasoningEffort } : {}),
      }),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Approve plan error:", error);
    return NextResponse.json({ error: "Failed to approve plan" }, { status: 500 });
  }
}
