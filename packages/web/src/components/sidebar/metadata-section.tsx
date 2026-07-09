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
import { prArtifactBelongsToRepo, type SessionRepositoryState } from "@open-inspect/shared";
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
} from "@/components/ui/icons";
import { Badge, prBadgeVariant } from "@/components/ui/badge";

type WarningEvent = Extract<SandboxEvent, { type: "warning" }>;

interface MetadataSectionProps {
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
}

/**
 * The PR artifact belonging to a member repo. The ownership convention
 * (identity-less artifact → primary; case-insensitive match) lives in shared
 * prArtifactBelongsToRepo — the same helper the control-plane prUrl projection
 * uses; here we only supply the identity parsed from the UI artifact metadata.
 */
function findPrArtifactForRepo(
  artifacts: Artifact[],
  repo: SessionRepositoryState,
  isPrimary: boolean
): Artifact | undefined {
  return artifacts.find((artifact) => {
    if (artifact.type !== "pr") return false;
    const { repoOwner, repoName } = artifact.metadata ?? {};
    const artifactRepo = repoOwner && repoName ? { repoOwner, repoName } : null;
    return prArtifactBelongsToRepo(artifactRepo, repo, isPrimary);
  });
}

export function MetadataSection({
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
}: MetadataSectionProps) {
  const [copied, setCopied] = useState(false);

  const isMultiRepo = (repositories?.length ?? 0) > 1;

  const prArtifact = artifacts.find((a) => a.type === "pr");
  const manualPrArtifact = artifacts.find(
    (a) => a.type === "branch" && (a.metadata?.mode === "manual_pr" || a.metadata?.createPrUrl)
  );
  const prNumber = prArtifact?.metadata?.prNumber;
  const prState = prArtifact?.metadata?.prState;
  const prUrl = getSafeExternalUrl(
    prArtifact?.url || manualPrArtifact?.metadata?.createPrUrl || manualPrArtifact?.url
  );
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
          {/* PR Badge */}
          {(prNumber || prUrl) && (
            <div className="flex items-center gap-2 text-sm">
              <RepoIcon className="w-4 h-4 text-muted-foreground" />
              {prUrl ? (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {prNumber ? `#${prNumber}` : "Create PR"}
                </a>
              ) : (
                <span className="text-foreground">#{prNumber}</span>
              )}
              {prState && (
                <Badge variant={prBadgeVariant(prState)} className="capitalize">
                  {prState}
                </Badge>
              )}
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
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Repositories
          </div>
          {repositories.map((repo, index) => {
            const memberPrArtifact = findPrArtifactForRepo(artifacts, repo, index === 0);
            const memberPrNumber = memberPrArtifact?.metadata?.prNumber;
            const memberPrState = memberPrArtifact?.metadata?.prState;
            const memberPrUrl = getSafeExternalUrl(
              memberPrArtifact?.url || repo.prUrl || undefined
            );
            const memberBranchUrl = repo.branchName
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
                {(repo.branchName || memberPrNumber || memberPrUrl) && (
                  <div className="ml-6 flex items-center gap-2 text-xs text-muted-foreground">
                    {repo.branchName && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <GitPrIcon className="w-3.5 h-3.5 flex-shrink-0" />
                        {memberBranchUrl ? (
                          <a
                            href={memberBranchUrl}
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
                    {(memberPrNumber || memberPrUrl) &&
                      (memberPrUrl ? (
                        <a
                          href={memberPrUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          {memberPrNumber ? `#${memberPrNumber}` : "PR"}
                        </a>
                      ) : (
                        <span className="text-foreground">#{memberPrNumber}</span>
                      ))}
                    {memberPrState && (
                      <Badge variant={prBadgeVariant(memberPrState)} className="capitalize">
                        {memberPrState}
                      </Badge>
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
