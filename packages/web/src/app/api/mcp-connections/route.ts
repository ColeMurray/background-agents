import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET() {
  const response = await controlPlaneUserFetch("/mcp-connections");
  return NextResponse.json(await response.json(), {
    status: response.status,
    headers: { "Cache-Control": "no-store" },
  });
}
