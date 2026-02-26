import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API_BASE = process.env.API_URL || "http://localhost:8787";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string; key: string }> }
) {
  const { owner, name, key } = await params;
  try {
    const response = await fetch(
      `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete repo secret:", error);
    return NextResponse.json({ error: "Failed to delete secret" }, { status: 500 });
  }
}
