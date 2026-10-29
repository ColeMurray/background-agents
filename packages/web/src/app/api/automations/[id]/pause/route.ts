import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const response = await controlPlaneUserFetch(`/automations/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to pause automation:", error);
    return NextResponse.json({ error: "Failed to pause automation" }, { status: 500 });
  }
}
