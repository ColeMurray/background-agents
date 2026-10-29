import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const response = await controlPlaneUserFetch(
      `/sessions/${encodeURIComponent(id)}/pull-requests/refresh`,
      {
        method: "POST",
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Refresh pull requests error:", error);
    return NextResponse.json({ error: "Failed to refresh pull requests" }, { status: 500 });
  }
}
