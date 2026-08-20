import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { REPO_IMAGES_UNSUPPORTED_MESSAGE, supportsRepoImages } from "@/lib/sandbox-provider";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!supportsRepoImages()) {
    return NextResponse.json({ error: REPO_IMAGES_UNSUPPORTED_MESSAGE }, { status: 501 });
  }

  const { owner, name } = await params;

  try {
    const body = await request.json();

    const response = await controlPlaneUserFetch(
      `/image-builds/toggle/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
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
