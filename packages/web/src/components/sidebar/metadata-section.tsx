"use client";

import { useState } from "react";
import { formatModelName, truncateBranch, copyToClipboard } from "@/lib/format";
import { formatRelativeTime } from "@/lib/time";
import type { Artifact } from "@/types/session";

interface MetadataSectionProps {
  createdAt: number;
  model?: string;
  reasoningEffort?: string;
  branchName?: string;
  repoOwner?: string;
  repoName?: string;
  vcsProvider?: "github" | "bitbucket";
  artifacts?: Artifact[];
}

export function MetadataSection({
  createdAt,
  model,
  reasoningEffort,
  branchName,
  repoOwner,
  repoName,
  vcsProvider = "github",
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
  const repoWebBase =
    vcsProvider === "bitbucket"
      ? `https://bitbucket.org/${repoOwner}/${repoName}`
      : `https://github.com/${repoOwner}/${repoName}`;
  const branchUrl =
    branchName && repoOwner && repoName
      ? vcsProvider === "bitbucket"
        ? `${repoWebBase}/src/${encodeURIComponent(branchName)}`
        : `${repoWebBase}/tree/${encodeURIComponent(branchName)}`
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
          <BranchIcon className="w-4 h-4 text-muted-foreground" />
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
          <RepoIcon className="w-4 h-4 text-muted-foreground" />
          <a
            href={repoWebBase}
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

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" strokeWidth={2} />
      <path strokeLinecap="round" strokeWidth={2} d="M12 6v6l4 2" />
    </svg>
  );
}

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}

function RepoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="16" rx="2" strokeWidth={2} />
      <path strokeLinecap="round" strokeWidth={2} d="M8 9h8M8 13h8M8 17h5" />
    </svg>
  );
}

function BranchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9"
      />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}
