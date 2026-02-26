import { NextResponse } from "next/server";

const API_BASE = process.env.API_URL || "http://localhost:8787";

export async function GET() {
  try {
    const response = await fetch(`${API_BASE}/repos`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch repos:", error);
    return NextResponse.json({ error: "Failed to fetch repos" }, { status: 500 });
  }
}
