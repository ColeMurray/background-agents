import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const response = await controlPlaneFetch(`/sessions/${id}/git/changes`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch session git changes:", error);
    return NextResponse.json({ error: "Failed to fetch git changes" }, { status: 500 });
  }
}
