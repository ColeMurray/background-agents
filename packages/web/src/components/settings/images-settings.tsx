"use client";

import { useState } from "react";
import { mutate } from "swr";
import { useImageBuilds } from "@/hooks/use-image-builds";
import { usePendingKeys } from "@/hooks/use-pending-keys";
import { useRepos } from "@/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBanner } from "@/components/ui/error-banner";
import { RefreshIcon } from "@/components/ui/icons";
import {
  IMAGE_BUILDS_KEY,
  foldEnabledRepoScopeIds,
  latestCurrentBuild,
  repoImageBuildScopeId,
} from "@/lib/image-builds";
import { supportsRepoImages } from "@/lib/sandbox-provider";
import { ImageBuildStatus } from "./image-build-status";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export function ImagesSettings() {
  const repoImagesSupported = supportsRepoImages();
  const { repos, loading: reposLoading } = useRepos();
  const { data, error: feedError, isLoading: imagesLoading } = useImageBuilds();
  const toggling = usePendingKeys();
  const triggering = usePendingKeys();
  const [error, setError] = useState("");

  if (!repoImagesSupported) {
    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Pre-Built Images</h2>
        <p className="text-sm text-muted-foreground">
          Pre-built images are only available when <code>SANDBOX_PROVIDER=modal</code>,{" "}
          <code>SANDBOX_PROVIDER=vercel</code>, or <code>SANDBOX_PROVIDER=opencomputer</code>.
        </p>
      </div>
    );
  }

  const loading = reposLoading || imagesLoading;

  // Toggle state reads the persisted flags, not `units` — the units feed
  // resolves scopes through source control and can transiently drop a repo.
  const enabledRepos = foldEnabledRepoScopeIds(data?.enabledRepos ?? []);

  const handleToggle = (owner: string, name: string, enabled: boolean) => {
    setError("");
    void toggling.run(repoImageBuildScopeId(owner, name), async () => {
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
      }
    });
  };

  const handleTrigger = (owner: string, name: string) => {
    setError("");
    void triggering.run(repoImageBuildScopeId(owner, name), async () => {
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
      }
    });
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading image settings...
      </div>
    );
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

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

        <div className="space-y-2">
          {repos.map((repo) => {
            const repoKey = repoImageBuildScopeId(repo.owner, repo.name);
            const isEnabled = enabledRepos.has(repoKey);
            const isToggling = toggling.pending.has(repoKey);
            const isTriggering = triggering.pending.has(repoKey);
            const image = latestCurrentBuild(data, "repo", repoKey);

            return (
              <div
                key={repo.id}
                className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={(checked) => handleToggle(repo.owner, repo.name, checked)}
                    disabled={isToggling}
                    aria-label={`Toggle pre-built images for ${repo.owner}/${repo.name}`}
                  />
                  <span className="text-sm font-medium text-foreground truncate">
                    {repo.owner}/{repo.name}
                  </span>
                </div>

                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <ImageBuildStatus isEnabled={isEnabled} image={image} />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleTrigger(repo.owner, repo.name)}
                    disabled={!isEnabled || isTriggering || image?.status === "building"}
                    title="Rebuild image"
                  >
                    <RefreshIcon className={`w-4 h-4 ${isTriggering ? "animate-spin" : ""}`} />
                  </Button>
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
