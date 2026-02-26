import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API_BASE = process.env.API_URL || "http://localhost:8787";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const response = await fetch(`${API_BASE}/sessions/${id}/unarchive`, { method: "POST" });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Unarchive session error:", error);
    return NextResponse.json({ error: "Failed to unarchive session" }, { status: 500 });
  }
}
