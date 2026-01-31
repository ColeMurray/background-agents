/**
 * Check Anthropic OAuth connection status for the current user.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneFetch(
      `/internal/anthropic-token/${encodeURIComponent(session.user.id)}`
    );

    if (!response.ok) {
      return NextResponse.json({ connected: false });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to check Anthropic status:", error);
    return NextResponse.json({ connected: false });
  }
}
