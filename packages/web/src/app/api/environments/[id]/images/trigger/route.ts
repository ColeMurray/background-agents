import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { rejectUnsupportedRepoImages } from "@/lib/repo-images-unsupported";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rejection = await rejectUnsupportedRepoImages();
    if (rejection) return rejection;

    const { id } = await params;
    const response = await controlPlaneUserFetch(
      `/image-builds/trigger/environment/${encodeURIComponent(id)}`,
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
