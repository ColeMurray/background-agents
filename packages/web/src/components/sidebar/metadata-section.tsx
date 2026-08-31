"use client";

import { useState } from "react";
import Link from "next/link";
import { formatModelName, truncateBranch, copyToClipboard } from "@/lib/format";
import { formatSessionCost } from "@/lib/session-cost";
import { formatRelativeTime } from "@/lib/time";
import { getSafeExternalUrl } from "@/lib/urls";
import { getScmBranchUrl, getScmRepoUrl } from "@/lib/scm";
import { NO_REPOSITORY_LABEL } from "@/lib/repo-label";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { SessionRepositoryState } from "@open-inspect/shared/types/repositories";
import { listPrArtifacts, listPrArtifactsForRepo } from "@/lib/pr-artifacts";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  ClockIcon,
  SparkleIcon,
  GitPrIcon,
  BranchIcon,
  RepoIcon,
  FolderIcon,
  CopyIcon,
  CheckIcon,
  LinkIcon,
  ErrorIcon,
  RefreshIcon,
} from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { prBadgeVariant } from "@/components/ui/badge-variants";

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
  totalCost?: number;
  canManageLifecycle: boolean;
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
      await browserApiFetch(`/api/sessions/${sessionId}/pull-requests/refresh`, {
        method: "POST",
      });
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
  totalCost,
  canManageLifecycle,
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

  return (
    <div className="space-y-3">
      {/* Timestamp */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ClockIcon className="w-4 h-4" />
        <span>{formatRelativeTime(createdAt)}</span>
      </div>

      {/* Parent session */}
      {parentSessionId && (
        <div className="flex items-center gap-2 text-sm">
          <LinkIcon className="w-4 h-4 text-muted-foreground" />
          <Link href={`/session/${parentSessionId}`} className="text-accent hover:underline">
            Parent session
          </Link>
        </div>
      )}

      {/* Model */}
      {model && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <SparkleIcon className="w-4 h-4" />
          <span>
            {formatModelName(model)}
            {reasoningEffort && <span> · {reasoningEffort}</span>}
          </span>
        </div>
      )}

      {typeof totalCost === "number" && totalCost > 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Session cost: {formatSessionCost(totalCost)}</span>
        </div>
      )}

      {/* Environment provenance */}
      {environmentId && (
        <div className="flex items-center gap-2 text-sm">
          <FolderIcon className="w-4 h-4 text-muted-foreground" />
          {environmentName ? (
            <span className="text-foreground truncate max-w-[180px]" title={environmentName}>
              {environmentName}
            </span>
          ) : (
            <span className="text-muted-foreground">Environment deleted</span>
          )}
        </div>
      )}

      {/* Scalar repo/PR/branch rows — single-repo (and scalar-era) sessions
          render exactly as before. Multi-repo sessions use the member list. */}
      {!isMultiRepo && (
        <>
          {/* PR rows — one per pull request, oldest first. A lone PR keeps
              the sync button inline; several move it to a section header so
              it clearly refreshes them all. */}
          {prArtifacts.length > 1 && (
            <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span>Pull requests</span>
              {showSyncButton && sessionId && <PullRequestSyncButton sessionId={sessionId} />}
            </div>
          )}
          {prArtifacts.map((artifact) => {
            const prNumber = artifact.metadata?.prNumber;
            const prState = artifact.metadata?.prState;
            const prHead = artifact.metadata?.head;
            const prUrl = getSafeExternalUrl(artifact.url ?? undefined);
            return (
              <div key={artifact.id} className="flex items-center gap-2 text-sm">
                <RepoIcon className="w-4 h-4 text-muted-foreground" />
                {prUrl ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    {prNumber ? `#${prNumber}` : "PR"}
                  </a>
                ) : (
                  <span className="text-foreground">{prNumber ? `#${prNumber}` : "PR"}</span>
                )}
                {prArtifacts.length > 1 && prHead && (
                  <span
                    className="min-w-0 truncate max-w-[120px] text-muted-foreground"
                    title={prHead}
                  >
                    {truncateBranch(prHead)}
                  </span>
                )}
                {prState && (
                  <Badge variant={prBadgeVariant(prState)} className="capitalize">
                    {prState}
                  </Badge>
                )}
                {prArtifacts.length === 1 && showSyncButton && sessionId && (
                  <PullRequestSyncButton sessionId={sessionId} />
                )}
              </div>
            );
          })}

          {/* Manual-PR fallback link (legacy sessions without a PR artifact) */}
          {manualPrUrl && (
            <div className="flex items-center gap-2 text-sm">
              <RepoIcon className="w-4 h-4 text-muted-foreground" />
              <a
                href={manualPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Create PR
              </a>
            </div>
          )}

          {/* Base Branch */}
          {baseBranch && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <BranchIcon className="w-4 h-4" />
              {repoOwner && repoName ? (
                <a
                  href={getScmBranchUrl(repoOwner, repoName, baseBranch)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent truncate max-w-[180px] hover:underline"
                  title={baseBranch}
                >
                  {truncateBranch(baseBranch)}
                </a>
              ) : (
                <span className="truncate max-w-[180px]" title={baseBranch}>
                  {truncateBranch(baseBranch)}
                </span>
              )}
            </div>
          )}

          {/* Working Branch */}
          {branchName && (
            <div className="flex items-center gap-2 text-sm">
              <GitPrIcon className="w-4 h-4 text-muted-foreground" />
              {branchUrl ? (
                <a
                  href={branchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent truncate max-w-[180px] hover:underline"
                  title={branchName}
                >
                  {truncateBranch(branchName)}
                </a>
              ) : (
                <span className="text-foreground truncate max-w-[180px]" title={branchName}>
                  {truncateBranch(branchName)}
                </span>
              )}
              <button
                type="button"
                onClick={handleCopyBranch}
                className="p-1 hover:bg-muted transition-colors"
                title={copied ? "Copied!" : "Copy branch name"}
              >
                {copied ? (
                  <CheckIcon className="w-3.5 h-3.5 text-success" />
                ) : (
                  <CopyIcon className="w-3.5 h-3.5 text-secondary-foreground" />
                )}
              </button>
            </div>
          )}

          {/* Repository tag */}
          {hasRepositoryMetadata && (
            <div className="flex items-center gap-2 text-sm">
              <RepoIcon className="w-4 h-4 text-muted-foreground" />
              {repoOwner && repoName ? (
                <a
                  href={getScmRepoUrl(repoOwner, repoName)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {repoOwner}/{repoName}
                </a>
              ) : (
                <span className="text-muted-foreground">{NO_REPOSITORY_LABEL}</span>
              )}
            </div>
          )}
        </>
      )}

      {/* Repository member list (multi-repo sessions) */}
      {isMultiRepo && repositories && (
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span>Repositories</span>
            {showSyncButton && sessionId && <PullRequestSyncButton sessionId={sessionId} />}
          </div>
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
              <div key={`${repo.repoOwner}/${repo.repoName}`} className="space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <RepoIcon className="w-4 h-4 text-muted-foreground" />
                  <a
                    href={getScmRepoUrl(repo.repoOwner, repo.repoName)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline truncate max-w-[170px]"
                    title={`${repo.repoOwner}/${repo.repoName}`}
                  >
                    {repo.repoOwner}/{repo.repoName}
                  </a>
                  {index === 0 && (
                    <Badge variant="info" className="text-[10px]">
                      primary
                    </Badge>
                  )}
                </div>
                {(repo.branchName || repoPrArtifacts.length > 0 || repoFallbackPrUrl) && (
                  <div className="ml-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {repo.branchName && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <GitPrIcon className="w-3.5 h-3.5 flex-shrink-0" />
                        {repoBranchUrl ? (
                          <a
                            href={repoBranchUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent truncate max-w-[120px] hover:underline"
                            title={repo.branchName}
                          >
                            {truncateBranch(repo.branchName)}
                          </a>
                        ) : (
                          <span className="truncate max-w-[120px]" title={repo.branchName}>
                            {truncateBranch(repo.branchName)}
                          </span>
                        )}
                      </span>
                    )}
                    {repoPrArtifacts.map((artifact) => {
                      const repoPrNumber = artifact.metadata?.prNumber;
                      const repoPrState = artifact.metadata?.prState;
                      const repoPrUrl = getSafeExternalUrl(artifact.url ?? undefined);
                      return (
                        <span key={artifact.id} className="inline-flex items-center gap-1">
                          {repoPrUrl ? (
                            <a
                              href={repoPrUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent hover:underline"
                            >
                              {repoPrNumber ? `#${repoPrNumber}` : "PR"}
                            </a>
                          ) : (
                            <span className="text-foreground">
                              {repoPrNumber ? `#${repoPrNumber}` : "PR"}
                            </span>
                          )}
                          {repoPrState && (
                            <Badge variant={prBadgeVariant(repoPrState)} className="capitalize">
                              {repoPrState}
                            </Badge>
                          )}
                        </span>
                      );
                    })}
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
              </div>
            );
          })}
        </div>
      )}

      {/* Non-fatal boot/runtime warnings */}
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((warning, index) => (
            <div
              key={warning.ackId ?? `${warning.scope}-${warning.timestamp}-${index}`}
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
