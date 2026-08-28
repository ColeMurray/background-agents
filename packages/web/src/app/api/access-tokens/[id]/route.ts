import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * Relay a control-plane response without assuming it carries JSON.
 *
 * Parsing before checking would turn an empty or non-JSON upstream reply — a
 * transport-level 401, a gateway error — into a 500 here, losing the status
 * the caller needs to act on.
 */
async function forward(response: Response): Promise<NextResponse> {
  const text = await response.text();
  if (!text) return new NextResponse(null, { status: response.status });
  try {
    return NextResponse.json(JSON.parse(text), { status: response.status });
  } catch {
    return NextResponse.json(
      { error: "Unexpected response from control plane" },
      { status: response.status >= 400 ? response.status : 502 }
    );
  }
}

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
    return await forward(
      await controlPlaneUserFetch(`/access-tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
    );
  } catch (error) {
    console.error("Failed to revoke access token:", error);
    return NextResponse.json({ error: "Failed to revoke access token" }, { status: 500 });
  }
}
