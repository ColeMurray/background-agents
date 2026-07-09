import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { supportsRepoImages } from "@/lib/sandbox-provider";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!supportsRepoImages()) {
    return NextResponse.json(
      {
        error:
          "Environment images are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer",
      },
      { status: 501 }
    );
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const response = await controlPlaneFetch(
      `/environment-images/trigger/${encodeURIComponent(id)}`,
      { method: "POST" }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to trigger environment image build:", error);
    return NextResponse.json(
      { error: "Failed to trigger environment image build" },
      { status: 500 }
    );
  }
}
