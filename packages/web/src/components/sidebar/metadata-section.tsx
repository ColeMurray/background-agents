"use client";

import { useState } from "react";
import { formatModelName, truncateBranch, copyToClipboard } from "@/lib/format";
import { formatRelativeTime } from "@/lib/time";
import type { Artifact } from "@/types/session";
import {
  ClockIcon,
  SparkleIcon,
  GitHubIcon,
  GitPrIcon,
  BranchIcon,
  CopyIcon,
  CheckIcon,
} from "@/components/ui/icons";
import { Badge, prBadgeVariant } from "@/components/ui/badge";

interface MetadataSectionProps {
  createdAt: number;
  model?: string;
  reasoningEffort?: string;
  baseBranch: string;
  branchName?: string;
  repoOwner?: string;
  repoName?: string;
  artifacts?: Artifact[];
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
}: MetadataSectionProps) {
  const [copied, setCopied] = useState(false);

  const prArtifact = artifacts.find((a) => a.type === "pr");
  const manualPrArtifact = artifacts.find(
    (a) => a.type === "branch" && (a.metadata?.mode === "manual_pr" || a.metadata?.createPrUrl)
  );
  const prNumber = prArtifact?.metadata?.prNumber;
  const prState = prArtifact?.metadata?.prState;
  const prUrl = prArtifact?.url || manualPrArtifact?.metadata?.createPrUrl || manualPrArtifact?.url;
  const branchUrl =
    branchName && repoOwner && repoName
      ? `https://github.com/${repoOwner}/${repoName}/tree/${encodeURIComponent(branchName)}`
      : null;

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

      {/* PR Badge */}
      {(prNumber || prUrl) && (
        <div className="flex items-center gap-2 text-sm">
          <GitHubIcon className="w-4 h-4 text-muted-foreground" />
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
              href={`https://github.com/${repoOwner}/${repoName}/tree/${encodeURIComponent(baseBranch)}`}
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
      {repoOwner && repoName && (
        <div className="flex items-center gap-2 text-sm">
          <GitHubIcon className="w-4 h-4 text-muted-foreground" />
          <a
            href={`https://github.com/${repoOwner}/${repoName}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            {repoOwner}/{repoName}
          </a>
        </div>
      )}
    </div>
  );
}
