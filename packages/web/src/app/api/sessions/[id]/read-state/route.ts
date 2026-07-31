import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

type SessionReadStatePatchBody =
  | { action: "acknowledge"; observedAttentionId: string }
  | { action: "mark_read" };

export function parseSessionReadStatePatchBody(value: unknown): SessionReadStatePatchBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.action === "mark_read" && Object.keys(record).length === 1) {
    return { action: "mark_read" };
  }
  if (
    record.action === "acknowledge" &&
    typeof record.observedAttentionId === "string" &&
    record.observedAttentionId.length > 0 &&
    Object.keys(record).length === 2
  ) {
    return { action: "acknowledge", observedAttentionId: record.observedAttentionId };
  }
  return null;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SessionReadStatePatchBody | null;
  try {
    body = parseSessionReadStatePatchBody(await request.json());
  } catch {
    body = null;
  }
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(`/sessions/${id}/read-state`, {
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
