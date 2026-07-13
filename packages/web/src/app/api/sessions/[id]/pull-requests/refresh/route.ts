import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Verify user is authenticated
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const response = await controlPlaneFetch(`/sessions/${id}/pull-requests/refresh`, {
      method: "POST",
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Refresh pull requests error:", error);
    return NextResponse.json({ error: "Failed to refresh pull requests" }, { status: 500 });
  }
}
