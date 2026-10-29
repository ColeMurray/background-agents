import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sessionBudgetUpdateSchema } from "@open-inspect/shared/types/session-api";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejection = rejectMissingBrowserSessionCookie(request, {
    "Cache-Control": "private, no-store",
  });
  if (rejection) return rejection;

  try {
    const parsed = sessionBudgetUpdateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { id } = await params;
    const response = await controlPlaneUserFetch(`/sessions/${encodeURIComponent(id)}/budget`, {
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
