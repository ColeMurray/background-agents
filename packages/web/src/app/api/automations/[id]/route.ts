import { updateAutomationRequestSchema } from "@open-inspect/shared/types/automations";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";

const UPDATE_FIELDS = updateAutomationRequestSchema.keyof().options;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const response = await controlPlaneUserFetch(`/automations/${encodeURIComponent(id)}`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch automation:", error);
    return NextResponse.json({ error: "Failed to fetch automation" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  const { id } = await params;

  try {
    const body = await request.json();
    const automationBody = Object.fromEntries(
      UPDATE_FIELDS.filter((field) => body[field] !== undefined).map((field) => [
        field,
        body[field],
      ])
    );
    const response = await controlPlaneUserFetch(`/automations/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(automationBody),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update automation:", error);
    return NextResponse.json({ error: "Failed to update automation" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  const { id } = await params;
  try {
    const body = await request.json();
    const response = await controlPlaneUserFetch(`/automations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ userId: body.userId }),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    console.error("Failed to update automation executor:", error);
    return NextResponse.json({ error: "Failed to update automation executor" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const response = await controlPlaneUserFetch(`/automations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete automation:", error);
    return NextResponse.json({ error: "Failed to delete automation" }, { status: 500 });
  }
}
