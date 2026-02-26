import { NextResponse } from "next/server";

// No auth needed for local mode — return a dummy token
export async function POST() {
  return NextResponse.json({ token: "local" });
}
