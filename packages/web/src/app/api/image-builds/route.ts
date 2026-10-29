import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import {
  excludeOtherProviderBuilds,
  excludeSupersededBuilds,
  imageBuildsEnabledReposResponseSchema,
  imageBuildsEnabledResponseSchema,
  imageBuildsStatusResponseSchema,
} from "@/lib/image-builds";
import { getPublicSandboxProvider } from "@/lib/sandbox-provider";
import { rejectUnsupportedRepoImages } from "@/lib/repo-images-unsupported";

/**
 * Unified image-build feed: every prebuild-enabled scope plus the cross-scope
 * build status — non-superseded, so failed builds are visible. One call for
 * the settings pages and the session-target picker.
 */
export async function GET() {
  try {
    const rejection = await rejectUnsupportedRepoImages();
    if (rejection) return rejection;

    const results = await Promise.allSettled([
      controlPlaneUserFetch("/image-builds/enabled"),
      controlPlaneUserFetch("/image-builds/enabled-repos"),
      controlPlaneUserFetch("/image-builds/status"),
    ]);

    if (results.some((result) => result.status === "fulfilled" && result.value.status === 401)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [enabledResponse, enabledReposResponse, statusResponse] = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });

    if (!enabledResponse.ok || !enabledReposResponse.ok || !statusResponse.ok) {
      return NextResponse.json({ error: "Failed to fetch image builds" }, { status: 502 });
    }

    const [enabledData, enabledReposData, statusData] = await Promise.all([
      enabledResponse.json(),
      enabledReposResponse.json(),
      statusResponse.json(),
    ]);
    const parsedEnabled = imageBuildsEnabledResponseSchema.safeParse(enabledData);
    const parsedEnabledRepos = imageBuildsEnabledReposResponseSchema.safeParse(enabledReposData);
    const parsedStatus = imageBuildsStatusResponseSchema.safeParse(statusData);
    if (!parsedEnabled.success || !parsedEnabledRepos.success || !parsedStatus.success) {
      return NextResponse.json({ error: "Failed to fetch image builds" }, { status: 502 });
    }

    // Serve the enabled scope identities and current fingerprints that the
    // status fold keys on.
    const units = parsedEnabled.data.units.map((unit) => ({
      scopeKind: unit.scopeKind,
      scopeId: unit.scopeId,
      repositoriesFingerprint: unit.repositoriesFingerprint,
    }));
    // Persisted repo flags, unlike units, never drop a scope on a transient
    // resolution failure — the settings toggles read these.
    const enabledRepos = parsedEnabledRepos.data.repos;
    const images = excludeOtherProviderBuilds(
      excludeSupersededBuilds(parsedStatus.data.images),
      getPublicSandboxProvider()
    );
    const admission = parsedEnabled.data.admission;

    return NextResponse.json({ units, enabledRepos, images, ...(admission ? { admission } : {}) });
  } catch (error) {
    console.error("Failed to fetch image builds:", error);
    return NextResponse.json({ error: "Failed to fetch image builds" }, { status: 500 });
  }
}
