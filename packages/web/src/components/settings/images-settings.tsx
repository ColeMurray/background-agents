"use client";

import { useState } from "react";
import { mutate } from "swr";
import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import { useImageBuilds } from "@/hooks/use-image-builds";
import { useRepos } from "@/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBanner } from "@/components/ui/error-banner";
import { RefreshIcon } from "@/components/ui/icons";
import {
  DEFAULT_IMAGE_BUILD_ADMISSION_OPEN,
  IMAGE_BUILDS_KEY,
  formatReadyDetails,
  parsePrimaryBuildSha,
} from "@/lib/image-builds";
import { REPO_IMAGES_UNSUPPORTED_MESSAGE, supportsRepoImages } from "@/lib/sandbox-provider";
import { ImageBuildStatus } from "./image-build-status";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

/**
 * Displays repository image configuration and limits image mutations to authorized users.
 */
export function ImagesSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManage = hasPermission("repositories.images.manage");
  const repoImagesSupported = supportsRepoImages();
  const { repos, loading: reposLoading } = useRepos();
  const { data, error: feedError, isLoading: imagesLoading } = useImageBuilds();
  const [togglingRepos, setTogglingRepos] = useState<Set<string>>(new Set());
  const [triggeringRepos, setTriggeringRepos] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  if (!repoImagesSupported) {
    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Pre-Built Images</h2>
        <p className="text-sm text-muted-foreground">{REPO_IMAGES_UNSUPPORTED_MESSAGE}.</p>
      </div>
    );
  }

  const loading = reposLoading || imagesLoading;
  const admissionOpen = data?.admission?.open ?? DEFAULT_IMAGE_BUILD_ADMISSION_OPEN;

  // Toggle state reads the persisted flags, not `units` — the units feed
  // resolves scopes through source control and can transiently drop a repo.
  const enabledRepos = new Set(
    (data?.enabledRepos ?? []).map((repo) => `${repo.repoOwner}/${repo.repoName}`.toLowerCase())
  );

  // Repo scope ids are lowercase `owner/name` pairs.
  const getLatestImage = (owner: string, name: string): ImageBuildRecordView | undefined => {
    const key = `${owner}/${name}`.toLowerCase();
    return data?.images.find((img) => img.scopeKind === "repo" && img.scopeId === key);
  };

  const handleToggle = async (owner: string, name: string, enabled: boolean) => {
    const repoKey = `${owner}/${name}`.toLowerCase();
    setTogglingRepos((prev) => new Set(prev).add(repoKey));
    setError("");

    try {
      const res = await browserApiFetch(
        `/api/image-builds/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/toggle`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }
      );

      if (!res.ok) {
        const errBody = await res.json();
        setError(errBody.error || "Failed to toggle image build");
      } else {
        mutate(IMAGE_BUILDS_KEY);
      }
    } catch {
      setError("Failed to toggle image build");
    } finally {
      setTogglingRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoKey);
        return next;
      });
    }
  };

  const handleTrigger = async (owner: string, name: string) => {
    const repoKey = `${owner}/${name}`.toLowerCase();
    setTriggeringRepos((prev) => new Set(prev).add(repoKey));
    setError("");

    try {
      const res = await browserApiFetch(
        `/api/image-builds/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/trigger`,
        { method: "POST" }
      );

      if (!res.ok) {
        const errBody = await res.json();
        setError(errBody.error || "Failed to trigger build");
      } else {
        mutate(IMAGE_BUILDS_KEY);
      }
    } catch {
      setError("Failed to trigger build");
    } finally {
      setTriggeringRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoKey);
        return next;
      });
    }
  };

  if (loading) {
    return <ImagesSettingsSkeleton showRebuild={canManage} />;
  }

  // Without the feed there is no toggle state to show — rendering the list
  // would present every repo as disabled and invite state-changing toggles.
  if (feedError && !data) {
    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Pre-Built Images</h2>
        <ErrorBanner>Failed to load image build settings.</ErrorBanner>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Pre-Built Images</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Enable pre-built images to speed up sandbox creation. Images are rebuilt automatically
          when the default branch changes.
        </p>

        {!admissionOpen && <PrebuildsPausedNotice />}

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

        <div className="space-y-2">
          {repos.map((repo) => {
            const repoKey = `${repo.owner}/${repo.name}`.toLowerCase();
            const isEnabled = enabledRepos.has(repoKey);
            const isToggling = togglingRepos.has(repoKey);
            const isTriggering = triggeringRepos.has(repoKey);
            const image = getLatestImage(repo.owner, repo.name);

            return (
              <div
                key={repo.id}
                className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={(checked) => handleToggle(repo.owner, repo.name, checked)}
                    disabled={!canManage || isToggling}
                    aria-label={`Toggle pre-built images for ${repo.owner}/${repo.name}`}
                  />
                  <span className="text-sm font-medium text-foreground truncate">
                    {repo.owner}/{repo.name}
                  </span>
                </div>

                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <ImageBuildStatus
                    isEnabled={isEnabled}
                    image={
                      image && {
                        status: image.status,
                        createdAt: image.createdAt,
                        readyDetails: formatReadyDetails(
                          parsePrimaryBuildSha(image.repositoryShas),
                          image.buildDurationSeconds
                        ),
                        errorMessage: image.errorMessage,
                      }
                    }
                  />
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleTrigger(repo.owner, repo.name)}
                      disabled={
                        !isEnabled || !admissionOpen || isTriggering || image?.status === "building"
                      }
                      title="Rebuild image"
                    >
                      <RefreshIcon className={`w-4 h-4 ${isTriggering ? "animate-spin" : ""}`} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {repos.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No repositories found. Install the GitHub App on repositories to get started.
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

const SKELETON_REPO_COUNT = 3;

/** Mirrors the loaded page: heading, description, and one row per repository. */
function ImagesSettingsSkeleton({ showRebuild }: { showRebuild: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading image settings"
      className="animate-pulse motion-reduce:animate-none"
    >
      <div className="h-5 w-40 bg-muted rounded mt-1 mb-2" />
      <div className="mb-6 py-0.5 space-y-1">
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-2/3 bg-muted rounded" />
      </div>

      <div className="space-y-2">
        {Array.from({ length: SKELETON_REPO_COUNT }, (_, index) => (
          <div
            key={index}
            className="flex items-center justify-between px-4 py-3 border border-border"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-5 w-9 shrink-0 bg-muted rounded-full" />
              <div className="h-4 w-44 bg-muted rounded" />
            </div>
            <div className="flex items-center gap-3 flex-shrink-0 ml-4">
              <div className="h-3 w-16 bg-muted rounded" />
              {showRebuild && <div className="size-7 bg-muted rounded" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A paused deployment still shows its toggles: they record intent an operator
 * can set before admission opens. It stops offering rebuilds, which would be
 * refused, and says why.
 */
function PrebuildsPausedNotice() {
  return (
    <p className="text-sm text-muted-foreground mb-4" role="status">
      Prebuilds are paused for this deployment. Existing images keep working; new builds start once
      an operator enables them.
    </p>
  );
}
