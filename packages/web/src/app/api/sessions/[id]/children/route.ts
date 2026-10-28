import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const response = await controlPlaneUserFetch(`/sessions/${encodeURIComponent(id)}/children`);
    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Fetch child sessions error:", error);
    return NextResponse.json({ error: "Failed to fetch child sessions" }, { status: 500 });
  }
}
