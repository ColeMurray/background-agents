import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sessionBudgetUpdateSchema } from "@open-inspect/shared/types/session-api";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = sessionBudgetUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(`/sessions/${id}/budget`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Update session budget error:", error);
    return NextResponse.json({ error: "Failed to update session budget" }, { status: 500 });
  }
}
