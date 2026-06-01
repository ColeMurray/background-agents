import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Verify user is authenticated
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id || session.user.email || "anonymous";
  const actorDisplayName = session.user.name || session.user.email || null;

  try {
    const response = await controlPlaneFetch(`/sessions/${id}/unarchive`, {
      method: "POST",
      body: JSON.stringify({
        userId,
        ...(actorDisplayName ? { actorDisplayName } : {}),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Unarchive session error:", error);
    return NextResponse.json({ error: "Failed to unarchive session" }, { status: 500 });
  }
}
