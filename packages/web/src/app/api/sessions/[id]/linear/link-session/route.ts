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
  let body: { linearIssueId?: string | null; linearTeamId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload: { linearIssueId?: string | null; linearTeamId?: string | null } = {};
  if ("linearIssueId" in body) payload.linearIssueId = body.linearIssueId ?? null;
  if ("linearTeamId" in body) payload.linearTeamId = body.linearTeamId ?? null;

  try {
    const response = await controlPlaneFetch(`/sessions/${id}/linear/link-session`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("Linear link session error:", error);
    return NextResponse.json({ error: "Failed to link session to Linear" }, { status: 500 });
  }
}
