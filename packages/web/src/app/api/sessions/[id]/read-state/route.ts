import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import {
  sessionReadActionSchema,
  type SessionReadAction,
} from "@open-inspect/shared/types/sessions";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejection = rejectMissingBrowserSessionCookie(request, {
    "Cache-Control": "private, no-store",
  });
  if (rejection) return rejection;

  let body: SessionReadAction | null;
  try {
    const parsedBody = sessionReadActionSchema.safeParse(await request.json());
    body = parsedBody.success ? parsedBody.data : null;
  } catch {
    body = null;
  }
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(`/sessions/${encodeURIComponent(id)}/read-state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Update session read state error:", error);
    return NextResponse.json({ error: "Failed to update session read state" }, { status: 500 });
  }
}
