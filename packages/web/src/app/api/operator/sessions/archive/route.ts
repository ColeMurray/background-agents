import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const response = await controlPlaneUserFetch("/operator/sessions/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = NextResponse.json(await response.json(), { status: response.status });
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  } catch (error) {
    console.error("Operator session archive error:", error);
    return NextResponse.json({ error: "Failed to archive sessions" }, { status: 500 });
  }
}
