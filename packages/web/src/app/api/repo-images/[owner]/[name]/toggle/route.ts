import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { supportsRepoImages } from "@/lib/sandbox-provider";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  if (!supportsRepoImages()) {
    return NextResponse.json(
      { error: "Repo images are only available when SANDBOX_PROVIDER=modal" },
      { status: 501 }
    );
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name } = await params;

  try {
    const body = await request.json();

    const response = await controlPlaneFetch(
      `/repo-images/toggle/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to toggle image build:", error);
    return NextResponse.json({ error: "Failed to toggle image build" }, { status: 500 });
  }
}
