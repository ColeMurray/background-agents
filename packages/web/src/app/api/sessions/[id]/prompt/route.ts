import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API_BASE = process.env.API_URL || "http://localhost:8787";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json();
    const response = await fetch(`${API_BASE}/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to send prompt:", error);
    return NextResponse.json({ error: "Failed to send prompt" }, { status: 500 });
  }
}
