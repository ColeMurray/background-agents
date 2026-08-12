import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { imageBuildStatusResponseSchema } from "@open-inspect/shared/types/image-builds";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { excludeSupersededBuilds } from "@/lib/image-builds";
import { supportsRepoImages } from "@/lib/sandbox-provider";

/** Per-environment image-build status (the environment's recent build rows). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!supportsRepoImages()) {
    return NextResponse.json(
      {
        error:
          "Image builds are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer",
      },
      { status: 501 }
    );
  }

  const { id } = await params;

  try {
    const response = await controlPlaneUserFetch(
      `/image-builds/status?scope_kind=environment&scope_id=${encodeURIComponent(id)}`
    );
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }
    const parsed = imageBuildStatusResponseSchema.safeParse(data);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Failed to fetch environment image status" },
        { status: 502 }
      );
    }
    return NextResponse.json({
      images: excludeSupersededBuilds(parsed.data.images),
    });
  } catch (error) {
    console.error("Failed to fetch environment image status:", error);
    return NextResponse.json(
      { error: "Failed to fetch environment image status" },
      { status: 500 }
    );
  }
}
