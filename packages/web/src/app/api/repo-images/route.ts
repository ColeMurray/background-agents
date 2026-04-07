import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { supportsRepoImages } from "@/lib/sandbox-provider";

export async function GET() {
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

  try {
    const [enabledResponse, statusResponse] = await Promise.all([
      controlPlaneFetch("/repo-images/enabled-repos"),
      controlPlaneFetch("/repo-images/status"),
    ]);

    if (!enabledResponse.ok || !statusResponse.ok) {
      return NextResponse.json({ error: "Failed to fetch repo images" }, { status: 502 });
    }

    const enabledData = await enabledResponse.json();
    const statusData = await statusResponse.json();

    const enabledRepos = (enabledData.repos ?? []).map(
      (r: { repoOwner: string; repoName: string }) => `${r.repoOwner}/${r.repoName}`
    );

    return NextResponse.json({
      enabledRepos,
      images: statusData.images ?? [],
    });
  } catch (error) {
    console.error("Failed to fetch repo images:", error);
    return NextResponse.json({ error: "Failed to fetch repo images" }, { status: 500 });
  }
}
