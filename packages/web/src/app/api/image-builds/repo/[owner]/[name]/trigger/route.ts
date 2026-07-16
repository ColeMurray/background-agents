import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { supportsRepoImages } from "@/lib/sandbox-provider";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!supportsRepoImages()) {
    return NextResponse.json(
      {
        error:
          "Image builds are only available when SANDBOX_PROVIDER=modal, vercel, opencomputer, or islo",
      },
      { status: 501 }
    );
  }

  const { owner, name } = await params;

  try {
    const response = await controlPlaneFetch(
      `/image-builds/trigger/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      { method: "POST" }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to trigger image build:", error);
    return NextResponse.json({ error: "Failed to trigger image build" }, { status: 500 });
  }
}
