import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API_BASE = process.env.API_URL || "http://localhost:8787";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  try {
    const response = await fetch(`${API_BASE}/secrets/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete secret:", error);
    return NextResponse.json({ error: "Failed to delete secret" }, { status: 500 });
  }
}
