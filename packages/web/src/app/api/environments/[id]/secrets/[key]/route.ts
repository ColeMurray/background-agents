import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; key: string }> }
) {
  const { id, key } = await params;

  try {
    const response = await controlPlaneUserFetch(
      `/environments/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete environment secret:", error);
    return NextResponse.json({ error: "Failed to delete environment secret" }, { status: 500 });
  }
}
