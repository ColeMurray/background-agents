"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorBanner } from "@/components/ui/error-banner";
import { RefreshIcon } from "@/components/ui/icons";
import {
  DEFAULT_IMAGE_BUILD_ADMISSION_OPEN,
  IMAGE_BUILDS_KEY,
  formatReadyDetails,
  parsePrimaryBuildSha,
} from "@/lib/image-builds";
import { useImageBuilds } from "@/hooks/use-image-builds";
import { formatSessionRepositoriesLabel } from "@/lib/repo-label";
import { supportsRepoImages } from "@/lib/sandbox-provider";
import { useEnvironments, ENVIRONMENTS_KEY } from "@/hooks/use-environments";
import { EnvironmentForm, type EnvironmentFormValues } from "./environment-form";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { EnvironmentIntegrationSettings } from "./environment-integration-settings";
import { EnvironmentSecretsImport } from "./environment-secrets-import";
import { ImageBuildStatus } from "./image-build-status";
import { SecretsEditor } from "@/components/secrets-editor";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

type View =
  | { mode: "list" }
  | { mode: "create" }
  | { mode: "edit"; environmentId: string; tab: "configuration" | "secrets" | "overrides" };

/**
 * Presents environments with configuration, secrets, settings, and image actions gated independently by permission.
 */
export function EnvironmentsSettings({
  teamId,
  canCreate: createAllowed,
}: { teamId?: string; canCreate?: boolean } = {}) {
  const { hasPermission } = useCurrentUserAuthorization();
  const canCreate = createAllowed ?? hasPermission("environments.manage");
  const canManageSecrets = hasPermission("environments.secrets.manage");
  const canManageRepoSecrets = hasPermission("repositories.secrets.manage");
  const canManageSettings = hasPermission("environments.settings.manage");
  const canManageImages = hasPermission("environments.images.manage");
  const canReadImages = hasPermission("image_builds.read");
  const canReadSettings = hasPermission("integrations.read");
  const { environments, loading, error: listError } = useEnvironments(teamId);
  const { mutate } = useSWRConfig();
  const refreshEnvironments = (environmentId?: string) =>
    mutate(
      (key) =>
        typeof key === "string" &&
        (key === ENVIRONMENTS_KEY ||
          key.startsWith(`${ENVIRONMENTS_KEY}?`) ||
          (environmentId !== undefined && key === `${ENVIRONMENTS_KEY}/${environmentId}`))
    );
  const { data: imageBuildsFeed, error: imageBuildsError } = useImageBuilds(
    canReadImages &&
      environments.some(
        (environment) => environment.capabilities?.canRead === true && environment.prebuildEnabled
      )
  );
  const admissionOpen = imageBuildsFeed?.admission?.open ?? DEFAULT_IMAGE_BUILD_ADMISSION_OPEN;
  const [view, setView] = useState<View>({ mode: "list" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [triggeringIds, setTriggeringIds] = useState<Set<string>>(new Set());

  const prebuildsSupported = supportsRepoImages();

  const handleCreate = async (values: EnvironmentFormValues) => {
    if (!canCreate) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await browserApiFetch("/api/environments", {
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
      await refreshEnvironments();
      toast.success(`Created ${values.name}`);
      const createdId = data?.environment?.id;
      setView(
        createdId && canManageSecrets && (!teamId || values.teamId === teamId)
          ? { mode: "edit", environmentId: createdId, tab: "secrets" }
          : { mode: "list" }
      );
    } catch {
      setError("Failed to create environment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (environmentId: string, values: EnvironmentFormValues) => {
    const environment = environments.find((entry) => entry.id === environmentId);
    if (environment?.capabilities?.canManage !== true) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await browserApiFetch(`/api/environments/${environmentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data?.error || "Failed to update environment");
      }
      await refreshEnvironments(environmentId);
      toast.success(`Saved ${values.name}`);
      setView({ mode: "list" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update environment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (environment: Environment) => {
    if (environment.capabilities?.canManage !== true) return;
    setError("");
    try {
      const response = await browserApiFetch(`/api/environments/${environment.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data?.error || "Failed to delete environment");
        return;
      }
      refreshEnvironments();
      toast.success(`Deleted ${environment.name}`);
    } catch {
      setError("Failed to delete environment");
    }
  };

  const handlePrebuildToggle = async (environment: Environment, enabled: boolean) => {
    if (environment.capabilities?.canManage !== true) return;
    setTogglingIds((prev) => new Set(prev).add(environment.id));
    setError("");
    try {
      const response = await browserApiFetch(`/api/environments/${environment.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prebuildEnabled: enabled }),
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data?.error || "Failed to toggle prebuilds");
      } else {
        refreshEnvironments();
        mutate(IMAGE_BUILDS_KEY);
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
    if (environment.capabilities?.canManage !== true || !canManageImages) return;
    setTriggeringIds((prev) => new Set(prev).add(environment.id));
    setError("");
    try {
      const response = await browserApiFetch(`/api/environments/${environment.id}/images/trigger`, {
        method: "POST",
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data?.error || "Failed to trigger build");
      } else {
        mutate(IMAGE_BUILDS_KEY);
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

  if (view.mode === "create" && canCreate) {
    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">New Environment</h2>
        <p className="text-sm text-muted-foreground mb-6">
          A named set of repositories that launch together in one workspace.
        </p>
        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}
        <EnvironmentForm
          mode="create"
          teamId={teamId}
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

    const canManage = environment.capabilities?.canManage === true;
    const canRead = environment.capabilities?.canRead === true;
    const tabs = (["configuration", "secrets", "overrides"] as const).filter(
      (tab) =>
        (tab === "configuration" && canManage) ||
        (tab === "secrets" && canRead && canManageSecrets) ||
        (tab === "overrides" && canRead && canReadSettings)
    );
    const activeTab = tabs.includes(view.tab) ? view.tab : tabs[0];
    if (!activeTab) {
      return (
        <Button variant="outline" size="xs" onClick={() => setView({ mode: "list" })}>
          Back to environments
        </Button>
      );
    }

    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">{environment.name}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {environment.description || "Edit this environment."}
        </p>

        <div className="flex items-center gap-1 border-b border-border-muted mb-4">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab}
              onClick={() => setView({ ...view, tab })}
              className={`px-3 py-2 text-sm capitalize transition border-b-2 -mb-px ${
                activeTab === tab
                  ? "border-accent text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

        {activeTab === "configuration" ? (
          <EnvironmentForm
            mode="edit"
            initialValues={environment}
            onSubmit={(values) => handleUpdate(environment.id, values)}
            onCancel={() => setView({ mode: "list" })}
            submitting={submitting}
          />
        ) : activeTab === "secrets" ? (
          <div>
            <p className="text-xs text-muted-foreground">
              Sessions launched from this environment get global secrets plus these — repository
              secrets do not carry over automatically. Changing secrets invalidates prebuilt images
              and triggers a rebuild.
            </p>
            <SecretsEditor
              scope="environment"
              environmentId={environment.id}
              disabled={!canManage || !canManageSecrets}
            />
            {canManage && canManageSecrets && canManageRepoSecrets && (
              <EnvironmentSecretsImport
                environmentId={environment.id}
                repositories={environment.repositories}
              />
            )}
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
              canManage={canManage && canManageSettings}
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
          {canCreate && (
            <Button size="xs" onClick={() => setView({ mode: "create" })}>
              New environment
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Named repository sets that launch together in one workspace, with their own secrets
          {prebuildsSupported ? " and prebuilt images" : ""}.
        </p>

        {prebuildsSupported && !admissionOpen && (
          <p className="text-sm text-muted-foreground mb-4" role="status">
            Prebuilds are paused for this deployment. Existing images keep working; new builds start
            once an operator enables them.
          </p>
        )}

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}
        {listError ? (
          <ErrorBanner className="mb-4" role="alert">
            Unable to load environments.
          </ErrorBanner>
        ) : null}

        {loading && <p className="text-sm text-muted-foreground">Loading environments...</p>}

        {!loading && !listError && environments.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No environments yet. Create one to launch multi-repository sessions with prebuilt
            images.
          </p>
        )}

        <div className="space-y-2">
          {environments.map((environment) => {
            const canManage = environment.capabilities?.canManage === true;
            const canRead = environment.capabilities?.canRead === true;
            const isToggling = togglingIds.has(environment.id);
            const isTriggering = triggeringIds.has(environment.id);

            return (
              <div key={environment.id} className="border border-border px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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

                  <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
                    {prebuildsSupported && (canManage || (canRead && canReadImages)) && (
                      <>
                        {canRead && canReadImages && (
                          <EnvironmentImageStatus
                            environment={environment}
                            image={imageBuildsFeed?.images.find(
                              (image) =>
                                image.scopeKind === "environment" &&
                                image.scopeId === environment.id
                            )}
                            feedUnavailable={Boolean(imageBuildsError) && !imageBuildsFeed}
                          />
                        )}
                        {canManage && (
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
                        )}
                        {canManage && canManageImages && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRebuild(environment)}
                            disabled={
                              !environment.prebuildEnabled || !admissionOpen || isTriggering
                            }
                            title="Rebuild image"
                          >
                            <RefreshIcon
                              className={`w-4 h-4 ${isTriggering ? "animate-spin" : ""}`}
                            />
                          </Button>
                        )}
                      </>
                    )}
                    {(canManage || (canRead && (canManageSecrets || canReadSettings))) && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setView({
                            mode: "edit",
                            environmentId: environment.id,
                            tab: canManage
                              ? "configuration"
                              : canManageSecrets
                                ? "secrets"
                                : "overrides",
                          })
                        }
                      >
                        Edit
                      </Button>
                    )}
                    {canManage &&
                      (confirmDeleteId === environment.id ? (
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
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setConfirmDeleteId(null)}
                          >
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
                      ))}
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

/**
 * Latest build status for an environment, out of the unified feed the page
 * fetches once. Presentation is the shared ImageBuildStatus.
 */
function EnvironmentImageStatus({
  environment,
  image: latestImage,
  feedUnavailable,
}: {
  environment: Environment;
  image: ImageBuildRecordView | undefined;
  feedUnavailable: boolean;
}) {
  // Distinguish a failed fetch from a genuinely build-less environment —
  // "No image" invites a manual rebuild the environment may not need.
  if (environment.prebuildEnabled && feedUnavailable) {
    return <span className="text-xs text-muted-foreground">Status unavailable</span>;
  }

  const image = environment.prebuildEnabled ? latestImage : undefined;

  return (
    <ImageBuildStatus
      isEnabled={environment.prebuildEnabled}
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
  );
}
