import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API_BASE = process.env.API_URL || "http://localhost:8787";

export async function GET() {
  try {
    const response = await fetch(`${API_BASE}/secrets`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch secrets:", error);
    return NextResponse.json({ error: "Failed to fetch secrets" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const response = await fetch(`${API_BASE}/secrets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update secrets:", error);
    return NextResponse.json({ error: "Failed to update secrets" }, { status: 500 });
  }
}
