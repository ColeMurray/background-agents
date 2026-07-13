"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import type { Environment, ImageBuildRecordView } from "@open-inspect/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorBanner } from "@/components/ui/error-banner";
import { RefreshIcon } from "@/components/ui/icons";
import { parsePrimaryBuildSha } from "@/lib/image-builds";
import { formatSessionRepositoriesLabel } from "@/lib/repo-label";
import { supportsRepoImages } from "@/lib/sandbox-provider";
import { useEnvironments, ENVIRONMENTS_KEY } from "@/hooks/use-environments";
import { EnvironmentForm, type EnvironmentFormValues } from "./environment-form";
import { EnvironmentIntegrationSettings } from "./environment-integration-settings";
import { EnvironmentSecretsImport } from "./environment-secrets-import";
import { ImageBuildStatus, formatReadyDetails } from "./image-build-status";
import { SecretsEditor } from "@/components/secrets-editor";

type View =
  | { mode: "list" }
  | { mode: "create" }
  | { mode: "edit"; environmentId: string; tab: "configuration" | "secrets" | "overrides" };

export function EnvironmentsSettings() {
  const { environments, loading } = useEnvironments();
  const [view, setView] = useState<View>({ mode: "list" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [triggeringIds, setTriggeringIds] = useState<Set<string>>(new Set());

  const prebuildsSupported = supportsRepoImages();

  const handleCreate = async (values: EnvironmentFormValues) => {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error || "Failed to create environment");
        return;
      }
      // Await the revalidation: the edit view resolves the environment from
      // the SWR cache, so switching before it refreshes flashes "not found".
      await mutate(ENVIRONMENTS_KEY);
      toast.success(`Created ${values.name}`);
      const createdId = data?.environment?.id;
      setView(
        createdId ? { mode: "edit", environmentId: createdId, tab: "secrets" } : { mode: "list" }
      );
    } catch {
      setError("Failed to create environment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (environmentId: string, values: EnvironmentFormValues) => {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/environments/${environmentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error || "Failed to update environment");
        return;
      }
      mutate(ENVIRONMENTS_KEY);
      toast.success(`Saved ${values.name}`);
      setView({ mode: "list" });
    } catch {
      setError("Failed to update environment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (environment: Environment) => {
    setError("");
    try {
      const response = await fetch(`/api/environments/${environment.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        setError(data?.error || "Failed to delete environment");
        return;
      }
      mutate(ENVIRONMENTS_KEY);
      toast.success(`Deleted ${environment.name}`);
    } catch {
      setError("Failed to delete environment");
    }
  };

  const handlePrebuildToggle = async (environment: Environment, enabled: boolean) => {
    setTogglingIds((prev) => new Set(prev).add(environment.id));
    setError("");
    try {
      const response = await fetch(`/api/environments/${environment.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prebuildEnabled: enabled }),
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data?.error || "Failed to toggle prebuilds");
      } else {
        mutate(ENVIRONMENTS_KEY);
        mutate(environmentImagesKey(environment.id));
      }
    } catch {
      setError("Failed to toggle prebuilds");
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(environment.id);
        return next;
      });
    }
  };

  const handleRebuild = async (environment: Environment) => {
    setTriggeringIds((prev) => new Set(prev).add(environment.id));
    setError("");
    try {
      const response = await fetch(`/api/environments/${environment.id}/images/trigger`, {
        method: "POST",
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data?.error || "Failed to trigger build");
      } else {
        mutate(environmentImagesKey(environment.id));
      }
    } catch {
      setError("Failed to trigger build");
    } finally {
      setTriggeringIds((prev) => {
        const next = new Set(prev);
        next.delete(environment.id);
        return next;
      });
    }
  };

  if (view.mode === "create") {
    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">New Environment</h2>
        <p className="text-sm text-muted-foreground mb-6">
          A named set of repositories that launch together in one workspace.
        </p>
        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}
        <EnvironmentForm
          mode="create"
          onSubmit={handleCreate}
          onCancel={() => setView({ mode: "list" })}
          submitting={submitting}
        />
      </div>
    );
  }

  if (view.mode === "edit") {
    const environment = environments.find((entry) => entry.id === view.environmentId);
    if (!environment) {
      return (
        <div>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading environment...</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-3">Environment not found.</p>
              <Button variant="outline" size="xs" onClick={() => setView({ mode: "list" })}>
                Back to environments
              </Button>
            </>
          )}
        </div>
      );
    }

    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">{environment.name}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {environment.description || "Edit this environment."}
        </p>

        <div className="flex items-center gap-1 border-b border-border-muted mb-4">
          {(["configuration", "secrets", "overrides"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setView({ ...view, tab })}
              className={`px-3 py-2 text-sm capitalize transition border-b-2 -mb-px ${
                view.tab === tab
                  ? "border-accent text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

        {view.tab === "configuration" ? (
          <EnvironmentForm
            mode="edit"
            initialValues={environment}
            onSubmit={(values) => handleUpdate(environment.id, values)}
            onCancel={() => setView({ mode: "list" })}
            submitting={submitting}
          />
        ) : view.tab === "secrets" ? (
          <div>
            <p className="text-xs text-muted-foreground">
              Sessions launched from this environment get global secrets plus these — repository
              secrets do not carry over automatically. Changing secrets invalidates prebuilt images
              and triggers a rebuild.
            </p>
            <SecretsEditor scope="environment" environmentId={environment.id} />
            <EnvironmentSecretsImport
              environmentId={environment.id}
              repositories={environment.repositories}
            />
            <div className="mt-4">
              <Button variant="outline" size="xs" onClick={() => setView({ mode: "list" })}>
                Back to environments
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <EnvironmentIntegrationSettings
              environmentId={environment.id}
              repositories={environment.repositories}
            />
            <div className="mt-4">
              <Button variant="outline" size="xs" onClick={() => setView({ mode: "list" })}>
                Back to environments
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-semibold text-foreground">Environments</h2>
          <Button size="xs" onClick={() => setView({ mode: "create" })}>
            New environment
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Named repository sets that launch together in one workspace, with their own secrets
          {prebuildsSupported ? " and prebuilt images" : ""}.
        </p>

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

        {loading && <p className="text-sm text-muted-foreground">Loading environments...</p>}

        {!loading && environments.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No environments yet. Create one to launch multi-repository sessions with prebuilt
            images.
          </p>
        )}

        <div className="space-y-2">
          {environments.map((environment) => {
            const isToggling = togglingIds.has(environment.id);
            const isTriggering = triggeringIds.has(environment.id);

            return (
              <div key={environment.id} className="border border-border px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {environment.name}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        {formatSessionRepositoriesLabel(null, null, environment.repositories)}
                      </span>
                    </div>
                    {environment.description && (
                      <p className="text-xs text-muted-foreground truncate">
                        {environment.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {prebuildsSupported && (
                      <>
                        <EnvironmentImageStatus environment={environment} />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Switch
                                checked={environment.prebuildEnabled}
                                onCheckedChange={(checked) =>
                                  handlePrebuildToggle(environment, checked)
                                }
                                disabled={isToggling}
                                aria-label={`Toggle prebuilt images for ${environment.name}`}
                              />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Prebuild images</TooltipContent>
                        </Tooltip>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRebuild(environment)}
                          disabled={!environment.prebuildEnabled || isTriggering}
                          title="Rebuild image"
                        >
                          <RefreshIcon
                            className={`w-4 h-4 ${isTriggering ? "animate-spin" : ""}`}
                          />
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        setView({
                          mode: "edit",
                          environmentId: environment.id,
                          tab: "configuration",
                        })
                      }
                    >
                      Edit
                    </Button>
                    {confirmDeleteId === environment.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="destructive"
                          size="xs"
                          onClick={() => {
                            handleDelete(environment);
                            setConfirmDeleteId(null);
                          }}
                        >
                          Confirm
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => setConfirmDeleteId(environment.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}

function environmentImagesKey(environmentId: string): string {
  return `/api/environments/${environmentId}/images`;
}

/**
 * Latest build status for an environment. Fetches only while prebuilds are
 * enabled — disabled environments show the static label. Presentation is the
 * shared ImageBuildStatus.
 */
function EnvironmentImageStatus({ environment }: { environment: Environment }) {
  const { data } = useSWR<{ images: ImageBuildRecordView[] }>(
    environment.prebuildEnabled ? environmentImagesKey(environment.id) : null
  );

  const image = environment.prebuildEnabled ? data?.images?.[0] : undefined;

  return (
    <ImageBuildStatus
      isEnabled={environment.prebuildEnabled}
      image={
        image && {
          status: image.status,
          createdAt: image.created_at,
          readyDetails: formatReadyDetails(
            parsePrimaryBuildSha(image.repository_shas),
            image.build_duration_seconds
          ),
          errorMessage: image.error_message,
        }
      }
    />
  );
}
