import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { buildControlPlanePath } from "@/lib/control-plane-query";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const path = buildControlPlanePath(
    `/automations/${encodeURIComponent(id)}/invocations`,
    request.nextUrl.searchParams
  );

  try {
    const response = await controlPlaneUserFetch(path);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch automation invocations:", error);
    return NextResponse.json({ error: "Failed to fetch automation invocations" }, { status: 500 });
  }
}
