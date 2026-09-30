"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { formatModelName, copyToClipboard } from "@/lib/format";
import { formatRelativeTime } from "@/lib/time";
import { getSafeExternalUrl } from "@/lib/urls";
import { getScmBranchUrl, getScmRepoUrl } from "@/lib/scm";
import { NO_REPOSITORY_LABEL } from "@/lib/repo-label";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { SessionRepositoryState } from "@open-inspect/shared/types/repositories";
import { listPrArtifacts, listPrArtifactsForRepo } from "@/lib/pr-artifacts";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";
import { toast } from "sonner";
import { GitPrIcon, CopyIcon, CheckIcon, ErrorIcon, RefreshIcon } from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { prBadgeVariant } from "@/components/ui/badge-variants";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { useTeam } from "@/hooks/use-teams";
import { PullRequestStateIcon } from "@/components/pr-state-icon";
import { DetailsSection, PropertyList, PropertyRow } from "./details-section";

type WarningEvent = Extract<SandboxEvent, { type: "warning" }>;

interface MetadataSectionProps {
  /** Enables the PR sync button; older callers without it just omit it. */
  sessionId?: string;
  createdAt: number;
  model?: string;
  reasoningEffort?: string;
  baseBranch: string | null;
  branchName?: string;
  repoOwner?: string | null;
  repoName?: string | null;
  artifacts?: Artifact[];
  /** Ordered member list ([0] = primary). Multi-member sessions render a
   *  per-repo list instead of the scalar repo tag. */
  repositories?: SessionRepositoryState[];
  /** Environment provenance (design §7.6): the name resolves live, so a
   *  non-null id with a null name means the environment was deleted. */
  environmentId?: string | null;
  environmentName?: string | null;
  /** Non-fatal boot/runtime warnings surfaced to the user. */
  warnings?: WarningEvent[];
  parentSessionId?: string | null;
  canManageLifecycle: boolean;
  ownerTeamId?: string | null;
  visibility?: SessionVisibility;
  /** Extra rows for the run property list, such as the session cost. */
  children?: ReactNode;
}

/**
 * Manual PR sync (design §7): kicks the read-through refresh; fresh state
 * arrives over the session socket as artifact_updated.
 */
function PullRequestSyncButton({ sessionId }: { sessionId: string }) {
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const response = await browserApiFetch(`/api/sessions/${sessionId}/pull-requests/refresh`, {
        method: "POST",
      });
      if (!response.ok) {
        toast.error(await sessionActionErrorMessage(response, "Failed to sync PR status"));
      }
    } catch {
      // Fire-and-forget: the socket stream is the source of truth, so a
      // failed trigger only means no update arrives.
    } finally {
      setSyncing(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleSync}
      disabled={syncing}
      className="p-1 hover:bg-muted transition-colors"
      title="Sync PR status"
      aria-label="Sync PR status"
    >
      <RefreshIcon
        className={`w-3.5 h-3.5 text-secondary-foreground ${syncing ? "animate-spin" : ""}`}
      />
    </button>
  );
}

/** One tracked PR: its state, its number (linked when the URL is safe), and its badge. */
function PullRequestRow({
  artifact,
  showHead = false,
}: {
  artifact: Artifact;
  showHead?: boolean;
}) {
  const prNumber = artifact.metadata?.prNumber;
  const prState = artifact.metadata?.prState;
  const prHead = artifact.metadata?.head;
  const prUrl = getSafeExternalUrl(artifact.url ?? undefined);
  const label = prNumber ? `#${prNumber}` : "PR";
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      {prState ? (
        <PullRequestStateIcon state={prState} label={`PR ${prState}`} />
      ) : (
        <GitPrIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
      )}
      {prUrl ? (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {label}
        </a>
      ) : (
        <span className="text-foreground">{label}</span>
      )}
      {showHead && prHead && (
        <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]" title={prHead}>
          {prHead}
        </span>
      )}
      {prState && (
        <Badge variant={prBadgeVariant(prState)} className="capitalize">
          {prState}
        </Badge>
      )}
    </span>
  );
}

export function MetadataSection({
  sessionId,
  createdAt,
  model,
  reasoningEffort,
  baseBranch,
  branchName,
  repoOwner,
  repoName,
  artifacts = [],
  repositories,
  environmentId,
  environmentName,
  warnings = [],
  parentSessionId,
  canManageLifecycle,
  ownerTeamId,
  visibility,
  children,
}: MetadataSectionProps) {
  const [copied, setCopied] = useState(false);

  const isMultiRepo = (repositories?.length ?? 0) > 1;
  const hasPrArtifact = artifacts.some((a) => a.type === "pr");
  const showSyncButton = canManageLifecycle && Boolean(sessionId) && hasPrArtifact;

  // Sessions can hold several PRs (one open PR per head branch); list them
  // all, oldest first — creation order matches PR-number order.
  const prArtifacts = listPrArtifacts(artifacts);
  const manualPrArtifact = artifacts.find(
    (a) => a.type === "branch" && (a.metadata?.mode === "manual_pr" || a.metadata?.createPrUrl)
  );
  const manualPrUrl =
    prArtifacts.length === 0
      ? getSafeExternalUrl(manualPrArtifact?.metadata?.createPrUrl || manualPrArtifact?.url)
      : null;
  const branchUrl =
    branchName && repoOwner && repoName ? getScmBranchUrl(repoOwner, repoName, branchName) : null;
  const hasRepositoryMetadata = repoOwner !== undefined && repoName !== undefined;

  const handleCopyBranch = async () => {
    if (branchName) {
      const success = await copyToClipboard(branchName);
      if (success) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  };

  const started = formatRelativeTime(createdAt);
  const syncButton =
    showSyncButton && sessionId ? <PullRequestSyncButton sessionId={sessionId} /> : null;
  const hasRepositoryRows =
    Boolean(baseBranch || branchName || manualPrUrl) || prArtifacts.length > 0;

  return (
    <div className="space-y-6">
      <DetailsSection title="Run information">
        <PropertyList>
          <PropertyRow label="Started">
            <span title={new Date(createdAt).toLocaleString()}>
              {started === "now" ? "Just now" : `${started} ago`}
            </span>
          </PropertyRow>
          {ownerTeamId !== undefined && (
            <PropertyRow label="Team">
              {ownerTeamId ? <OwningTeam id={ownerTeamId} /> : <span>Workspace (no team)</span>}
            </PropertyRow>
          )}
          {visibility && (
            <PropertyRow label="Visibility">
              <span className="capitalize">{visibility}</span>
            </PropertyRow>
          )}
          {model && (
            <PropertyRow label="Model">
              {formatModelName(model)}
              {reasoningEffort && (
                <span className="text-muted-foreground"> · {reasoningEffort}</span>
              )}
            </PropertyRow>
          )}
          {/* Environment provenance */}
          {environmentId && (
            <PropertyRow label="Environment">
              {environmentName ?? (
                <span className="text-muted-foreground">Environment deleted</span>
              )}
            </PropertyRow>
          )}
          {parentSessionId && (
            <PropertyRow label="Parent">
              <Link href={`/session/${parentSessionId}`} className="text-accent hover:underline">
                Parent session
              </Link>
            </PropertyRow>
          )}
          {children}
        </PropertyList>
      </DetailsSection>

      {/* Single-repository context. Multi-repo sessions use the member list. */}
      {!isMultiRepo && (hasRepositoryMetadata || hasRepositoryRows) && (
        <DetailsSection title="Repository" action={syncButton}>
          {hasRepositoryMetadata && (
            <p className="text-xs">
              {repoOwner && repoName ? (
                <a
                  href={getScmRepoUrl(repoOwner, repoName)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent [overflow-wrap:anywhere] hover:underline"
                  title={`${repoOwner}/${repoName}`}
                >
                  {repoOwner}/{repoName}
                </a>
              ) : (
                <span className="text-muted-foreground">{NO_REPOSITORY_LABEL}</span>
              )}
            </p>
          )}
          {hasRepositoryRows && (
            <PropertyList>
              {baseBranch && (
                <PropertyRow label="Base">
                  {repoOwner && repoName ? (
                    <a
                      href={getScmBranchUrl(repoOwner, repoName, baseBranch)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                      title={baseBranch}
                    >
                      {baseBranch}
                    </a>
                  ) : (
                    <span title={baseBranch}>{baseBranch}</span>
                  )}
                </PropertyRow>
              )}
              {branchName && (
                <PropertyRow label="Branch">
                  <span className="flex items-start justify-between gap-1">
                    {branchUrl ? (
                      <a
                        href={branchUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 text-accent hover:underline"
                        title={branchName}
                      >
                        {branchName}
                      </a>
                    ) : (
                      <span className="min-w-0" title={branchName}>
                        {branchName}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={handleCopyBranch}
                      className="-my-1 shrink-0 rounded p-1 hover:bg-muted transition-colors"
                      title={copied ? "Copied!" : "Copy branch name"}
                      aria-label={copied ? "Copied branch name" : "Copy branch name"}
                    >
                      {copied ? (
                        <CheckIcon className="w-3.5 h-3.5 text-success" />
                      ) : (
                        <CopyIcon className="w-3.5 h-3.5 text-secondary-foreground" />
                      )}
                    </button>
                  </span>
                </PropertyRow>
              )}
              {prArtifacts.length > 0 && (
                <PropertyRow label={prArtifacts.length > 1 ? "Pull requests" : "Pull request"}>
                  <span className="block space-y-1.5">
                    {prArtifacts.map((artifact) => (
                      // Several PRs stay distinguishable by their head branch.
                      <span key={artifact.id} className="block">
                        <PullRequestRow artifact={artifact} showHead={prArtifacts.length > 1} />
                      </span>
                    ))}
                  </span>
                </PropertyRow>
              )}
              {/* Manual-PR fallback link (legacy sessions without a PR artifact) */}
              {manualPrUrl && (
                <PropertyRow label="Pull request">
                  <a
                    href={manualPrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    Create PR
                  </a>
                </PropertyRow>
              )}
            </PropertyList>
          )}
        </DetailsSection>
      )}

      {/* Repository member list (multi-repo sessions) */}
      {isMultiRepo && repositories && (
        <DetailsSection title="Repositories" action={syncButton}>
          <ul className="space-y-4">
            {repositories.map((repo, index) => {
              const repoPrArtifacts = listPrArtifactsForRepo(artifacts, repo, index === 0);
              // The scalar mirror is only a fallback for sessions whose PR
              // artifacts have not synced yet.
              const repoFallbackPrUrl =
                repoPrArtifacts.length === 0 ? getSafeExternalUrl(repo.prUrl || undefined) : null;
              const repoBranchUrl = repo.branchName
                ? getScmBranchUrl(repo.repoOwner, repo.repoName, repo.branchName)
                : null;
              return (
                <li key={`${repo.repoOwner}/${repo.repoName}`} className="space-y-1.5 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <a
                      href={getScmRepoUrl(repo.repoOwner, repo.repoName)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 text-accent [overflow-wrap:anywhere] hover:underline"
                      title={`${repo.repoOwner}/${repo.repoName}`}
                    >
                      {repo.repoOwner}/{repo.repoName}
                    </a>
                    {index === 0 && (
                      <Badge variant="info" className="shrink-0 text-[10px]">
                        primary
                      </Badge>
                    )}
                  </div>
                  {repo.branchName && (
                    <div className="flex items-start gap-1.5 text-muted-foreground">
                      <GitPrIcon className="mt-px w-3.5 h-3.5 shrink-0" />
                      {repoBranchUrl ? (
                        <a
                          href={repoBranchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 text-accent [overflow-wrap:anywhere] hover:underline"
                          title={repo.branchName}
                        >
                          {repo.branchName}
                        </a>
                      ) : (
                        <span className="min-w-0 [overflow-wrap:anywhere]" title={repo.branchName}>
                          {repo.branchName}
                        </span>
                      )}
                    </div>
                  )}
                  {(repoPrArtifacts.length > 0 || repoFallbackPrUrl) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {repoPrArtifacts.map((artifact) => (
                        <PullRequestRow key={artifact.id} artifact={artifact} />
                      ))}
                      {repoFallbackPrUrl && (
                        <a
                          href={repoFallbackPrUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          PR
                        </a>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </DetailsSection>
      )}

      {/* Non-fatal boot/runtime warnings */}
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((warning) => (
            <div
              key={
                warning.ackId ??
                [
                  warning.scope,
                  warning.timestamp,
                  warning.sandboxId,
                  warning.repoOwner,
                  warning.repoName,
                  warning.message,
                ].join(":")
              }
              className="flex items-start gap-2 text-xs text-warning"
            >
              <ErrorIcon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="min-w-0">
                {(warning.repoOwner && warning.repoName
                  ? `${warning.repoOwner}/${warning.repoName}: `
                  : "") + warning.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OwningTeam({ id }: { id: string }) {
  const { team, loading, error } = useTeam(id);
  if (!team || error)
    return (
      <span className="text-muted-foreground">
        {loading ? "Loading team..." : "Team unavailable"}
      </span>
    );
  return (
    <Link
      href={`/teams/${encodeURIComponent(team.slug)}`}
      className="truncate text-accent hover:underline"
    >
      {team.name}
    </Link>
  );
}
