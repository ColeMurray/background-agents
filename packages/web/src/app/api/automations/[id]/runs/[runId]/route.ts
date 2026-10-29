import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  const { id, runId } = await params;

  try {
    const response = await controlPlaneUserFetch(
      `/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch automation run:", error);
    return NextResponse.json({ error: "Failed to fetch automation run" }, { status: 500 });
  }
}
