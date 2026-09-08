import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json();

    const response = await controlPlaneUserFetch(
      `/environments/${encodeURIComponent(id)}/secrets/import`,
      { method: "POST", body: JSON.stringify(body) }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to import environment secrets:", error);
    return NextResponse.json({ error: "Failed to import environment secrets" }, { status: 500 });
  }
}
