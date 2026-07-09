import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { supportsRepoImages } from "@/lib/sandbox-provider";

/**
 * Cross-environment image status (ready and building rows of prebuild-enabled
 * environments) — the picker's one-call source for prebuild status. Failed
 * rows are per-environment detail: /api/environments/[id]/images.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!supportsRepoImages()) {
    return NextResponse.json(
      {
        error:
          "Environment images are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer",
      },
      { status: 501 }
    );
  }

  try {
    const response = await controlPlaneFetch("/environment-images/status");
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch environment image status:", error);
    return NextResponse.json(
      { error: "Failed to fetch environment image status" },
      { status: 500 }
    );
  }
}
