"use client";

import { useState } from "react";
import { toast } from "sonner";
import { findPrArtifactForRepo } from "@/lib/pr-artifacts";
import { getSafeExternalUrl } from "@/lib/urls";
import type { Artifact } from "@/types/session";

export interface SessionActionProps {
  sessionId: string;
  sessionStatus: string;
  artifacts: Artifact[];
  /** Select the repository's PR instead of the first PR in multi-repo sessions. */
  primaryRepo?: { repoOwner: string; repoName: string } | null;
  onArchive?: () => void | Promise<void>;
  onUnarchive?: () => void | Promise<void>;
}

export function resolveSessionActions(
  artifacts: Artifact[],
  primaryRepo?: SessionActionProps["primaryRepo"]
) {
  const prArtifact = primaryRepo
    ? findPrArtifactForRepo(artifacts, primaryRepo, true)
    : artifacts.find((artifact) => artifact.type === "pr");
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
    } finally {
      setIsArchiving(false);
    }
  };

  const handleConfirmArchive = async () => {
    setShowArchiveDialog(false);
    setIsArchiving(true);
    try {
      if (onArchive) await onArchive();
    } finally {
      setIsArchiving(false);
    }
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/session/${sessionId}`;
    await navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
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
