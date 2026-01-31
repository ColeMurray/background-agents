/**
 * Disconnect Anthropic OAuth for the current user.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function POST() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneFetch(
      `/internal/anthropic-token/${encodeURIComponent(session.user.id)}`,
      { method: "DELETE" }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("Failed to disconnect Anthropic:", text);
      return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
    }

    return NextResponse.json({ status: "disconnected" });
  } catch (error) {
    console.error("Failed to disconnect Anthropic:", error);
    return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
  }
}
