import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { relayJsonResponse } from "@/lib/control-plane-json-proxy";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    return await relayJsonResponse(
      await controlPlaneUserFetch(`/access-tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
    );
  } catch (error) {
    console.error("Failed to revoke access token:", error);
    return NextResponse.json({ error: "Failed to revoke access token" }, { status: 500 });
  }
}
