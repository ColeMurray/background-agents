import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API_BASE = process.env.API_URL || "http://localhost:8787";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const { owner, name } = await params;
  try {
    const response = await fetch(
      `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/secrets`
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch repo secrets:", error);
    return NextResponse.json({ error: "Failed to fetch secrets" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const { owner, name } = await params;
  try {
    const body = await request.json();
    const response = await fetch(
      `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/secrets`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update repo secrets:", error);
    return NextResponse.json({ error: "Failed to update secrets" }, { status: 500 });
  }
}
