import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { DEFAULT_THEME_ID } from "@/lib/theme";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || session?.user?.email || null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneFetch(`/user-preferences/${encodeURIComponent(userId)}`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch user preferences:", error);
    return NextResponse.json({ theme: DEFAULT_THEME_ID }, { status: 200 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || session?.user?.email || null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const response = await controlPlaneFetch(`/user-preferences/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ theme: body.theme }),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update user preferences:", error);
    return NextResponse.json({ error: "Failed to update user preferences" }, { status: 500 });
  }
}
