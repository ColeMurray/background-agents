"use client";

import { useState } from "react";
import type { PullRequestDisplayStatus } from "@open-inspect/shared/types/artifacts";
import { prArtifactBelongsToRepo } from "@open-inspect/shared/types/repositories";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import { toast } from "sonner";
import { truncateBranch } from "@/lib/format";
import { listPrArtifacts } from "@/lib/pr-artifacts";
import { getSafeExternalUrl } from "@/lib/urls";
import type { Artifact } from "@/types/session";
import type { SessionCapabilities } from "@/lib/session-capabilities";

export interface SessionActionProps {
  sessionId: string;
  sessionStatus: SessionStatus;
  artifacts: Artifact[];
  /** Labels PRs on other repositories with their repo in multi-repo sessions. */
  primaryRepo?: { repoOwner: string; repoName: string } | null;
  onArchive?: () => void | Promise<void>;
  onUnarchive?: () => void | Promise<void>;
  capabilities: SessionCapabilities;
}

/** One PR a session-level action can open, ready to render as a link. */
interface SessionPrLink {
  id: string;
  url: string;
  /** "#12 · head-branch"; prefixed "owner/name#12" outside the primary repo. */
  label: string;
  prState?: PullRequestDisplayStatus;
}

function prLinkLabel(artifact: Artifact, primaryRepo?: SessionActionProps["primaryRepo"]): string {
  const { prNumber, head, repoOwner, repoName } = artifact.metadata ?? {};
  // Ownership follows the shared convention: identity-less metadata belongs
  // to the primary repo, so only a different explicit identity earns a prefix.
  const isForeignRepo =
    primaryRepo != null &&
    !prArtifactBelongsToRepo(
      repoOwner !== undefined && repoName !== undefined ? { repoOwner, repoName } : null,
      primaryRepo,
      true
    );
  const repoPrefix = isForeignRepo ? `${repoOwner}/${repoName}` : "";
  const name =
    prNumber !== undefined ? `${repoPrefix}#${prNumber}` : repoPrefix ? `${repoPrefix} PR` : "PR";
  return head ? `${name} · ${truncateBranch(head)}` : name;
}

export function resolveSessionActions(
  artifacts: Artifact[],
  primaryRepo?: SessionActionProps["primaryRepo"]
) {
  // Sessions can hold several PRs (one open PR per head branch, across
  // repos); surface every linkable one, oldest first, and let the caller
  // render a single button or a picker.
  const prLinks: SessionPrLink[] = listPrArtifacts(artifacts).flatMap((artifact) => {
    const url = getSafeExternalUrl(artifact.url);
    if (!url) return [];
    return [
      {
        id: artifact.id,
        url,
        label: prLinkLabel(artifact, primaryRepo),
        prState: artifact.metadata?.prState,
      },
    ];
  });
  const previewArtifact = artifacts.find((artifact) => artifact.type === "preview");

  return {
    previewArtifact,
    previewUrl: getSafeExternalUrl(previewArtifact?.url),
    prLinks,
    mediaCount: artifacts.filter(
      (artifact) => artifact.type === "screenshot" || artifact.type === "video"
    ).length,
  };
}

export function useSessionActionControls({
  sessionId,
  sessionStatus,
  onArchive,
  onUnarchive,
}: Pick<SessionActionProps, "sessionId" | "sessionStatus" | "onArchive" | "onUnarchive">) {
  const [isArchiving, setIsArchiving] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const isArchived = sessionStatus === "archived";

  const handleArchiveToggle = async () => {
    if (!isArchived) {
      setShowArchiveDialog(true);
      return;
    }

    setIsArchiving(true);
    try {
      if (onUnarchive) await onUnarchive();
    } catch {
      toast.error("Failed to unarchive session");
    } finally {
      setIsArchiving(false);
    }
  };

  const handleConfirmArchive = async () => {
    setShowArchiveDialog(false);
    setIsArchiving(true);
    try {
      if (onArchive) await onArchive();
    } catch {
      toast.error("Failed to archive session");
    } finally {
      setIsArchiving(false);
    }
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/session/${sessionId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Failed to copy link");
    }
  };

  return {
    isArchived,
    isArchiving,
    showArchiveDialog,
    setShowArchiveDialog,
    handleArchiveToggle,
    handleConfirmArchive,
    handleCopyLink,
  };
}
