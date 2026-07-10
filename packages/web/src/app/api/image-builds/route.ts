import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { ImageBuildRecordView } from "@open-inspect/shared";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { excludeSupersededBuilds, type ImageBuildUnitView } from "@/lib/image-builds";
import { supportsRepoImages } from "@/lib/sandbox-provider";

/**
 * Unified image-build feed: every prebuild-enabled scope plus the cross-scope
 * build status — non-superseded, so failed builds are visible. One call for
 * the settings pages and the session-target picker.
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
          "Image builds are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer",
      },
      { status: 501 }
    );
  }

  try {
    const [enabledResponse, statusResponse] = await Promise.all([
      controlPlaneFetch("/image-builds/enabled"),
      controlPlaneFetch("/image-builds/status"),
    ]);

    if (!enabledResponse.ok || !statusResponse.ok) {
      return NextResponse.json({ error: "Failed to fetch image builds" }, { status: 502 });
    }

    const enabledData = await enabledResponse.json();
    const statusData = await statusResponse.json();

    // The enabled feed carries cron detail (fingerprint, repositories) the
    // web doesn't need — serve only the scope identities.
    const units = ((enabledData.units ?? []) as ImageBuildUnitView[]).map((unit) => ({
      scopeKind: unit.scopeKind,
      scopeId: unit.scopeId,
    }));
    const images = excludeSupersededBuilds((statusData.images ?? []) as ImageBuildRecordView[]);

    return NextResponse.json({ units, images });
  } catch (error) {
    console.error("Failed to fetch image builds:", error);
    return NextResponse.json({ error: "Failed to fetch image builds" }, { status: 500 });
  }
}
