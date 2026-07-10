import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { supportsRepoImages } from "@/lib/sandbox-provider";

interface ImageBuildEnabledRepo {
  repoOwner: string;
  repoName: string;
}

/** Unified image-build row fields this translation reads (snake_case D1 columns). */
interface ImageBuildRecord {
  scope_kind: string;
  scope_id: string;
  status: string;
  repository_shas: string;
  build_duration_seconds: number | null;
  error_message: string | null;
  created_at: number;
}

/**
 * Translate a unified repo-scope record into the RepoImage shape this route
 * has always served (the repo settings page reads base_sha; the unified rows
 * carry repository_shas provenance instead). Temporary: the full web
 * convergence onto the unified shape is a follow-up slice.
 */
function toRepoImage(record: ImageBuildRecord): Record<string, unknown> | null {
  const [repoOwner, repoName] = record.scope_id.split("/");
  if (!repoOwner || !repoName) return null;

  return {
    repo_owner: repoOwner,
    repo_name: repoName,
    status: record.status,
    base_sha: parsePrimaryBaseSha(record.repository_shas),
    build_duration_seconds: record.build_duration_seconds,
    error_message: record.error_message ?? undefined,
    created_at: record.created_at,
  };
}

function parsePrimaryBaseSha(repositoryShas: string): string {
  try {
    const parsed: unknown = JSON.parse(repositoryShas);
    if (!Array.isArray(parsed) || parsed.length === 0) return "";
    const primary: unknown = parsed[0];
    if (typeof primary !== "object" || primary === null) return "";
    const baseSha = (primary as { baseSha?: unknown }).baseSha;
    return typeof baseSha === "string" ? baseSha : "";
  } catch {
    return "";
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!supportsRepoImages()) {
    return NextResponse.json(
      {
        error:
          "Repo images are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer",
      },
      { status: 501 }
    );
  }

  try {
    const [enabledResponse, statusResponse] = await Promise.all([
      controlPlaneFetch("/image-builds/enabled-repos"),
      controlPlaneFetch("/image-builds/status"),
    ]);

    if (!enabledResponse.ok || !statusResponse.ok) {
      return NextResponse.json({ error: "Failed to fetch repo images" }, { status: 502 });
    }

    const enabledData = await enabledResponse.json();
    const statusData = await statusResponse.json();

    // The persisted-flags feed: toggle state must come from the flag rows,
    // not the resolution-dependent units feed, so a transient source-control
    // failure can never flip a toggle off in the UI.
    const enabledRepos = ((enabledData.repos ?? []) as ImageBuildEnabledRepo[]).map(
      (repo) => `${repo.repoOwner}/${repo.repoName}`
    );

    const images = ((statusData.images ?? []) as ImageBuildRecord[])
      .filter((record) => record.scope_kind === "repo")
      .map(toRepoImage)
      .filter((image) => image !== null);

    return NextResponse.json({ enabledRepos, images });
  } catch (error) {
    console.error("Failed to fetch repo images:", error);
    return NextResponse.json({ error: "Failed to fetch repo images" }, { status: 500 });
  }
}
