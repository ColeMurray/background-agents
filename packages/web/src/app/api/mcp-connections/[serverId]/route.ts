import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ serverId: string }> }
) {
  const { serverId } = await context.params;
  const response = await controlPlaneUserFetch(`/mcp-connections/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
  });
  return NextResponse.json(await response.json(), {
    status: response.status,
    headers: { "Cache-Control": "no-store" },
  });
}
