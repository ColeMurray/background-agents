"use client";

import Link from "next/link";
import { useState, useCallback, useEffect, useRef, type TouchEvent } from "react";
import { ArchiveSessionDialog } from "@/components/archive-session-dialog";
import { archiveSession } from "@/lib/archive-session";
import { pullRequestSummaryDisplay } from "@/lib/pr-summary";
import { PullRequestStateIcon } from "@/components/pr-state-icon";
import { formatRelativeTime } from "@/lib/time";
import { MoreIcon, ArchiveIcon, BranchIcon, BoxIcon } from "@/components/ui/icons";
import { formatSessionRepositoriesLabel } from "@/lib/repo-label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionItem } from "@/hooks/use-sidebar-sessions";

export const MOBILE_LONG_PRESS_MS = 450;
const MOBILE_LONG_PRESS_MOVE_THRESHOLD_PX = 10;

export function buildSessionHref(session: SessionItem) {
  const query: Record<string, string> = {};
  if (session.repoOwner && session.repoName) {
    query.repoOwner = session.repoOwner;
    query.repoName = session.repoName;
  }
  if (session.title) {
    query.title = session.title;
  }

  return {
    pathname: `/session/${session.id}`,
    query,
  };
}

export function SessionListItem({
  session,
  environmentName,
  isActive,
  isMobile,
  onArchive,
  onSessionSelect,
  onSessionRenamed,
}: {
  session: SessionItem;
  environmentName?: string;
  isActive: boolean;
  isMobile: boolean;
  onArchive: (sessionId: string) => Promise<void>;
  onSessionSelect?: () => void;
  onSessionRenamed: (sessionId: string, title: string) => void;
}) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const repoInfo = formatSessionRepositoriesLabel(
    session.repoOwner,
    session.repoName,
    session.repositories
  );
  const prDisplay = pullRequestSummaryDisplay(session.pullRequestSummary);
  const displayTitle = session.title || repoInfo;
  // Orphan child (parent filtered out) — show a subtle badge
  const isOrphanChild = session.parentSessionId && session.spawnSource === "agent";
  const [isRenaming, setIsRenaming] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [title, setTitle] = useState(displayTitle);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isStartingRenameRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isRenaming) {
      setTitle(displayTitle);
    }
  }, [displayTitle, isRenaming]);

  const handleStartRename = () => {
    isStartingRenameRef.current = true;
    setIsActionsOpen(false);
    setTitle(displayTitle);
    setIsRenaming(true);
  };

  useEffect(() => {
    if (!isRenaming) return;

    const timeout = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [isRenaming]);

  const handleCancelRename = () => {
    setTitle(displayTitle);
    setIsRenaming(false);
  };

  const handleStartArchive = () => {
    setIsActionsOpen(false);
    setShowArchiveDialog(true);
  };

  const handleConfirmArchive = async () => {
    setShowArchiveDialog(false);
    setIsArchiving(true);

    try {
      const didArchive = await archiveSession(session.id);
      if (didArchive) {
        await onArchive(session.id);
      }
    } finally {
      setIsArchiving(false);
    }
  };

  const handleRenameSubmit = async () => {
    const trimmed = title.trim();

    if (!trimmed || trimmed === displayTitle) {
      setIsRenaming(false);
      return;
    }

    const previousTitle = displayTitle;
    setIsRenaming(false);

    try {
      const response = await fetch(`/api/sessions/${session.id}/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!response.ok) {
        throw new Error("Failed to update session title");
      }
      onSessionRenamed(session.id, trimmed);
    } catch {
      setTitle(previousTitle);
      setIsRenaming(true);
    }
  };

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleTouchStart = useCallback(
    (event: TouchEvent<HTMLAnchorElement>) => {
      if (!isMobile) return;

      const touch = event.touches[0];
      if (!touch) return;

      longPressTriggeredRef.current = false;
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      clearLongPressTimer();
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        setIsActionsOpen(true);
      }, MOBILE_LONG_PRESS_MS);
    },
    [clearLongPressTimer, isMobile]
  );

  const handleTouchMove = useCallback(
    (event: TouchEvent<HTMLAnchorElement>) => {
      if (!isMobile) return;

      const start = touchStartRef.current;
      const touch = event.touches[0];
      if (!start || !touch) return;

      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      if (Math.hypot(deltaX, deltaY) > MOBILE_LONG_PRESS_MOVE_THRESHOLD_PX) {
        clearLongPressTimer();
      }
    },
    [clearLongPressTimer, isMobile]
  );

  const handleTouchEnd = useCallback(() => {
    clearLongPressTimer();
    touchStartRef.current = null;
  }, [clearLongPressTimer]);

  useEffect(() => {
    return () => clearLongPressTimer();
  }, [clearLongPressTimer]);

  return (
    <>
      <div
        className={`group relative block px-4 py-2.5 border-l-2 transition ${
          isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
        }`}
      >
        {isRenaming ? (
          <>
            <input
              ref={renameInputRef}
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  handleCancelRename();
                }
              }}
              className="w-full text-sm bg-transparent text-foreground outline-none focus:ring-inset focus:ring-ring font-medium pr-8"
            />
            <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
              <span>{relativeTime}</span>
              <span>·</span>
              <span className="truncate">{repoInfo}</span>
            </div>
          </>
        ) : (
          <Link
            href={buildSessionHref(session)}
            onClick={(event) => {
              if (longPressTriggeredRef.current) {
                event.preventDefault();
                longPressTriggeredRef.current = false;
                return;
              }
              if (isMobile) {
                onSessionSelect?.();
              }
            }}
            onContextMenu={(event) => {
              if (isMobile) {
                event.preventDefault();
              }
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            className="block pr-8"
          >
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {prDisplay && (
                <PullRequestStateIcon state={prDisplay.state} label={prDisplay.label} />
              )}
              <span className="truncate">{displayTitle}</span>
            </div>
            <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
              <span>{relativeTime}</span>
              <span>·</span>
              <span className="truncate">{repoInfo}</span>
              {environmentName && (
                <>
                  <span>·</span>
                  <BoxIcon className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{environmentName}</span>
                </>
              )}
              {isOrphanChild && (
                <>
                  <span>·</span>
                  <span className="text-accent">sub-task</span>
                </>
              )}
              {session.baseBranch && session.baseBranch !== "main" && (
                <>
                  <span>·</span>
                  <BranchIcon className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{session.baseBranch}</span>
                </>
              )}
            </div>
          </Link>
        )}

        <div className="absolute inset-y-0 right-2 flex items-start pt-2">
          <DropdownMenu open={isActionsOpen} onOpenChange={setIsActionsOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Session actions"
                aria-hidden={isMobile ? "true" : undefined}
                tabIndex={isMobile ? -1 : undefined}
                className={`h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition data-[state=open]:opacity-100 ${
                  isMobile
                    ? "pointer-events-none flex opacity-0"
                    : "flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                <MoreIcon className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (isStartingRenameRef.current) {
                  event.preventDefault();
                  isStartingRenameRef.current = false;
                }
              }}
            >
              <DropdownMenuItem onSelect={handleStartRename}>Rename</DropdownMenuItem>
              <DropdownMenuItem onClick={handleStartArchive} disabled={isArchiving}>
                <ArchiveIcon className="w-4 h-4" />
                Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ArchiveSessionDialog
        open={showArchiveDialog}
        onOpenChange={setShowArchiveDialog}
        onConfirm={handleConfirmArchive}
      />
    </>
  );
}

export function ChildSessionListItem({
  session,
  isActive,
  isMobile,
  onSessionSelect,
  depth,
}: {
  session: SessionItem;
  isActive: boolean;
  isMobile: boolean;
  onSessionSelect?: () => void;
  depth: number;
}) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const prDisplay = pullRequestSummaryDisplay(session.pullRequestSummary);
  const displayTitle = session.title || "Sub-task";
  const paddingLeftRem = 1.75 + Math.max(depth - 1, 0) * 1;
  return (
    <Link
      href={buildSessionHref(session)}
      onClick={() => {
        if (isMobile) {
          onSessionSelect?.();
        }
      }}
      className={`block pr-4 py-1.5 border-l-2 transition ${
        isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
      }`}
      style={{ paddingLeft: `${paddingLeftRem}rem` }}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <span className="shrink-0 text-muted-foreground">{relativeTime}</span>
        {prDisplay && <PullRequestStateIcon state={prDisplay.state} label={prDisplay.label} />}
        <span className="truncate font-medium text-foreground">{displayTitle}</span>
      </div>
    </Link>
  );
}
