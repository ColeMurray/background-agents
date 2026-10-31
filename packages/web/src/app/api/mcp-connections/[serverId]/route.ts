import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ serverId: string }> }
) {
  const { serverId } = await context.params;
  try {
    const response = await controlPlaneUserFetch(
      `/mcp-connections/${encodeURIComponent(serverId)}`,
      { method: "DELETE" }
    );
    return await relayJsonResponse(response);
  } catch (error) {
    console.error("Failed to disconnect MCP connection:", error);
    return NextResponse.json(
      { error: "Failed to disconnect MCP connection" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}
