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
  CopyIcon,
  CheckIcon,
} from "@/components/ui/icons";

interface MetadataSectionProps {
  createdAt: number;
  model?: string;
  reasoningEffort?: string;
  branchName?: string;
  repoOwner?: string;
  repoName?: string;
  artifacts?: Artifact[];
}

export function MetadataSection({
  createdAt,
  model,
  reasoningEffort,
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

  const getPrBadgeStyles = (state?: string) => {
    switch (state) {
      case "merged":
        return "bg-success-muted text-success";
      case "closed":
        return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
      case "draft":
        return "bg-muted text-muted-foreground";
      case "open":
      default:
        return "bg-accent-muted text-accent";
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
            <span
              className={`px-1.5 py-0.5 text-xs font-medium capitalize ${getPrBadgeStyles(prState)}`}
            >
              {prState}
            </span>
          )}
        </div>
      )}

      {/* Branch */}
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
