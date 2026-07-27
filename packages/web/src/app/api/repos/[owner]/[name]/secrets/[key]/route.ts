import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string; key: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name, key } = await params;

  try {
    const response = await controlPlaneUserFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete repo secret:", error);
    return NextResponse.json({ error: "Failed to delete repo secret" }, { status: 500 });
  }
}
