import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";

export async function GET() {
  try {
    const response = await controlPlaneUserFetch("/mcp-connections");
    return await relayJsonResponse(response);
  } catch (error) {
    console.error("Failed to fetch MCP connections:", error);
    return NextResponse.json(
      { error: "Failed to fetch MCP connections" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}
