import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { parseSessionTitlePatchBody } from "./parse-request";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: { title?: string } | null;
  try {
    body = parseSessionTitlePatchBody(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const response = await controlPlaneUserFetch(`/sessions/${id}/title`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // userId is derived by the control plane from the Bearer principal and
      // is rejected in the body under strict enforcement.
      body: JSON.stringify({ title: body.title }),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Update session title error:", error);
    return NextResponse.json({ error: "Failed to update the session title" }, { status: 500 });
  }
}
