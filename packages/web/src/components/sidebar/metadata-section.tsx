"use client";

import { useState, useEffect, useCallback } from "react";
import { formatModelName, truncateBranch, copyToClipboard } from "@/lib/format";
import { formatRelativeTime } from "@/lib/time";
import type { Artifact } from "@/types/session";
import { listLinearTeams, listLinearIssues, linkSessionToLinear } from "@/lib/linear";
import type { LinearTeam } from "@/lib/linear";
import type { LinearIssue } from "@/types/session";

interface MetadataSectionProps {
  sessionId: string;
  createdAt: number;
  model?: string;
  branchName?: string;
  repoOwner?: string;
  repoName?: string;
  artifacts?: Artifact[];
  linearIssueId?: string | null;
}

export function MetadataSection({
  sessionId,
  createdAt,
  model,
  branchName,
  repoOwner,
  repoName,
  artifacts = [],
  linearIssueId,
}: MetadataSectionProps) {
  const [copied, setCopied] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [unlinkLoading, setUnlinkLoading] = useState(false);

  const prArtifact = artifacts.find((a) => a.type === "pr");
  const prNumber = prArtifact?.metadata?.prNumber;
  const prState = prArtifact?.metadata?.prState;
  const prUrl = prArtifact?.url;
  const screenshotArtifacts = artifacts.filter((a) => a.type === "screenshot");
  const previewArtifact = artifacts.find((a) => a.type === "preview");

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
          <span>{formatModelName(model)}</span>
        </div>
      )}

      {/* Linear link (session-level): link / change / unlink */}
      <div className="flex items-center gap-2 text-sm">
        <LinearIcon className="w-4 h-4 text-muted-foreground shrink-0" />
        {linearIssueId ? (
          <span className="flex items-center gap-2 flex-wrap">
            <a
              href={`https://linear.app/issue/${linearIssueId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Linked to Linear
            </a>
            <button
              type="button"
              onClick={() => setLinkModalOpen(true)}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              Change
            </button>
            <button
              type="button"
              onClick={async () => {
                if (unlinkLoading) return;
                setUnlinkLoading(true);
                try {
                  await linkSessionToLinear(sessionId, { linearIssueId: null });
                  setLinkModalOpen(false);
                } finally {
                  setUnlinkLoading(false);
                }
              }}
              disabled={unlinkLoading}
              className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
            >
              {unlinkLoading ? "…" : "Unlink"}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setLinkModalOpen(true)}
            className="text-accent hover:underline text-left"
          >
            Link to Linear
          </button>
        )}
      </div>
      {linkModalOpen && (
        <LinkSessionToLinearModal
          sessionId={sessionId}
          onClose={() => setLinkModalOpen(false)}
          onLinked={() => setLinkModalOpen(false)}
        />
      )}

      {/* PR Badge */}
      {prNumber && (
        <div className="flex items-center gap-2 text-sm">
          <GitHubIcon className="w-4 h-4 text-muted-foreground" />
          {prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              #{prNumber}
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
          <span className="text-foreground truncate max-w-[180px]" title={branchName}>
            {truncateBranch(branchName)}
          </span>
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

      {/* Screenshots */}
      {screenshotArtifacts.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ImageIcon className="w-4 h-4" />
            <span>Screenshots</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {screenshotArtifacts.map((a) => (
              <a
                key={a.id}
                href={a.url ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded border border-border overflow-hidden hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-accent"
                title="View full screenshot"
              >
                <img
                  src={a.url ?? ""}
                  alt="Screenshot"
                  className="h-20 w-auto max-w-[140px] object-cover object-top"
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Preview link (compact; full "View preview" is in action bar) */}
      {previewArtifact?.url && (
        <div className="flex items-center gap-2 text-sm">
          <GlobeIcon className="w-4 h-4 text-muted-foreground" />
          <a
            href={previewArtifact.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline truncate max-w-[180px]"
            title={previewArtifact.url}
          >
            Live preview
          </a>
          {previewArtifact.metadata?.previewStatus === "outdated" && (
            <span className="text-xs text-amber-600 dark:text-amber-400">(outdated)</span>
          )}
        </div>
      )}
    </div>
  );
}

function LinkSessionToLinearModal({
  sessionId,
  onClose,
  onLinked,
}: {
  sessionId: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await listLinearTeams();
      setTeams(t);
      if (t.length > 0) setSelectedTeamId((prev) => prev || t[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load teams");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadIssues = useCallback(async () => {
    if (!selectedTeamId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listLinearIssues({ teamId: selectedTeamId, limit: 50 });
      setIssues(result.issues);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load issues");
    } finally {
      setLoading(false);
    }
  }, [selectedTeamId]);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    if (selectedTeamId) loadIssues();
  }, [selectedTeamId, loadIssues]);

  const handleTeamChange = (teamId: string) => {
    setSelectedTeamId(teamId);
    setIssues([]);
  };

  const handleLink = async (issueId: string) => {
    setLoading(true);
    setError(null);
    try {
      await linkSessionToLinear(sessionId, {
        linearIssueId: issueId,
        linearTeamId: selectedTeamId || undefined,
      });
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to link");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-lg p-4 w-full max-w-md max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-medium mb-3">Link session to Linear</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Choose an existing Linear issue to link to this session. The sandbox will receive its
          context when you start a run.
        </p>
        {error && <p className="text-destructive text-sm mb-2">{error}</p>}
        <div className="space-y-2 mb-3">
          <label className="block text-xs text-muted-foreground">Team</label>
          <select
            className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background"
            value={selectedTeamId}
            onChange={(e) => handleTeamChange(e.target.value)}
            onFocus={loadTeams}
          >
            <option value="">Select team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.key})
              </option>
            ))}
          </select>
        </div>
        {selectedTeamId && (
          <div className="space-y-2 mb-3">
            <label className="block text-xs text-muted-foreground">Issue</label>
            <ul className="max-h-48 overflow-y-auto border border-border rounded divide-y divide-border">
              {loading && issues.length === 0 ? (
                <li className="px-2 py-2 text-sm text-muted-foreground">Loading…</li>
              ) : (
                issues.map((issue) => (
                  <li
                    key={issue.id}
                    className="flex items-center justify-between gap-2 px-2 py-1.5"
                  >
                    <span className="text-sm truncate flex-1" title={issue.title}>
                      {issue.identifier}: {issue.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleLink(issue.id)}
                      disabled={loading}
                      className="shrink-0 text-xs text-accent hover:underline disabled:opacity-50"
                    >
                      Link
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
        <div className="flex justify-end mt-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-border rounded hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
      />
    </svg>
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

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0012 2z"
      />
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

function LinearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.5 3H3v10.5h10.5V3zM21 3h-7.5v4.5H21V3zM21 10.5h-7.5V21H21V10.5zM13.5 16.5V21H3v-4.5h10.5z" />
    </svg>
  );
}
