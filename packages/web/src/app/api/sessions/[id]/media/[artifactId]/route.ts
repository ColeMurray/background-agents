import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; artifactId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId, artifactId } = await params;

  try {
    const response = await controlPlaneFetch(`/sessions/${sessionId}/media/${artifactId}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch media URL: ${errorText}`);
      return NextResponse.json({ error: "Failed to fetch media URL" }, { status: response.status });
    }

    const body = await response.json();
    return NextResponse.json(body, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to fetch media URL:", error);
    return NextResponse.json({ error: "Failed to fetch media URL" }, { status: 500 });
  }
}
