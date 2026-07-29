import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneUserFetch("/model-preferences");
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch model preferences:", error);
    return NextResponse.json({ error: "Failed to fetch model preferences" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    const response = await controlPlaneUserFetch("/model-preferences", {
      method: "PUT",
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update model preferences:", error);
    return NextResponse.json({ error: "Failed to update model preferences" }, { status: 500 });
  }
}
