import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; grantId: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, grantId } = await params;
  const response = await controlPlaneUserFetch(
    `/automations/${encodeURIComponent(id)}/external-action-grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" }
  );
  return NextResponse.json(await response.json(), {
    status: response.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
