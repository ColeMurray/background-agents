"use client";

import { useState } from "react";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import { toast } from "sonner";
import { findLatestOpenPrArtifact } from "@/lib/pr-artifacts";
import { getSafeExternalUrl } from "@/lib/urls";
import type { Artifact } from "@/types/session";

export interface SessionActionProps {
  sessionId: string;
  sessionStatus: SessionStatus;
  artifacts: Artifact[];
  /** Scope the PR action to the repository's PRs in multi-repo sessions. */
  primaryRepo?: { repoOwner: string; repoName: string } | null;
  onArchive?: () => void | Promise<void>;
  onUnarchive?: () => void | Promise<void>;
}

export function resolveSessionActions(
  artifacts: Artifact[],
  primaryRepo?: SessionActionProps["primaryRepo"]
) {
  // Sessions can hold several PRs per repo; the action targets the latest
  // open one (else the latest overall) — the sidebar lists them all.
  const prArtifact = findLatestOpenPrArtifact(artifacts, primaryRepo ?? null, true);
  const previewArtifact = artifacts.find((artifact) => artifact.type === "preview");

  return {
    previewArtifact,
    previewUrl: getSafeExternalUrl(previewArtifact?.url),
    prUrl: getSafeExternalUrl(prArtifact?.url),
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
