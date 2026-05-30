import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { resolveCurrentUserId } from "@/lib/current-user";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const resolved = await resolveCurrentUserId(session.user);
    if (!resolved.ok) {
      return NextResponse.json(resolved.body, { status: resolved.status });
    }

    return NextResponse.json({ userId: resolved.userId });
  } catch (error) {
    console.error("Failed to resolve current user:", error);
    return NextResponse.json({ error: "Failed to resolve current user" }, { status: 500 });
  }
}
