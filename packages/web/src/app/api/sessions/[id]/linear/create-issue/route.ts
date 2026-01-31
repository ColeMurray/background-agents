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
  let body: {
    messageId: string;
    eventId: string;
    taskIndex: number;
    teamId: string;
    title?: string;
    description?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.messageId || !body.eventId || typeof body.taskIndex !== "number" || !body.teamId) {
    return NextResponse.json(
      { error: "messageId, eventId, taskIndex, and teamId are required" },
      { status: 400 }
    );
  }

  try {
    const response = await controlPlaneFetch(`/sessions/${id}/linear/create-issue`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error("Linear create issue error:", error);
    return NextResponse.json({ error: "Failed to create Linear issue" }, { status: 500 });
  }
}
