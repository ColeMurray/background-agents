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

  let body: { reason?: string } = {};
  try {
    body = (await request.json()) as { reason?: string };
  } catch {
    // empty body is acceptable — reject without a reason
  }

  try {
    const response = await controlPlaneFetch(`/sessions/${id}/plan/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approverAuthorId: `web:${userId}`,
        reason: typeof body.reason === "string" ? body.reason : null,
      }),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Reject plan error:", error);
    return NextResponse.json({ error: "Failed to reject plan" }, { status: 500 });
  }
}
