import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Verify user is authenticated
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    // userId is derived by the control plane from the Bearer principal and
    // is rejected in the body under strict enforcement.
    const response = await controlPlaneUserFetch(`/sessions/${id}/unarchive`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Unarchive session error:", error);
    return NextResponse.json({ error: "Failed to unarchive session" }, { status: 500 });
  }
}
