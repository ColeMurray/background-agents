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
import { useSessionRename } from "@/hooks/use-session-rename";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionItem } from "@/hooks/use-sidebar-sessions";
import { buildSessionHref } from "@/lib/session-list";

const MOBILE_LONG_PRESS_MS = 450;
const MOBILE_LONG_PRESS_MOVE_THRESHOLD_PX = 10;

/**
 * Displays a session and derives lifecycle controls from the current user's workspace permissions.
 */
export function SessionListItem({
  session,
  environmentName,
  isActive,
  isMobile,
  onArchive,
  onSessionSelect,
  onMarkLatestMessageRead,
}: {
  session: SessionItem;
  environmentName?: string;
  isActive: boolean;
  isMobile: boolean;
  onArchive: (sessionId: string) => Promise<void>;
  onSessionSelect?: () => void;
  onMarkLatestMessageRead: (sessionId: string) => Promise<void>;
}) {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManageLifecycle = hasPermission("sessions.lifecycle");
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const repoInfo = formatSessionRepositoriesLabel(
    session.repoOwner,
    session.repoName,
    session.repositories
  );
  const prDisplay = pullRequestSummaryDisplay(session.pullRequestSummary);
  const { optimisticTitle, renameSession } = useSessionRename({
    sessionId: session.id,
    currentTitle: session.title,
  });
  const displayTitle = optimisticTitle ?? session.title ?? repoInfo;
  // Orphan child (parent filtered out) — show a subtle badge
  const isOrphanChild = session.parentSessionId && session.spawnSource === "agent";
  const [isRenaming, setIsRenaming] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [isMarkingLatestRead, setIsMarkingLatestRead] = useState(false);
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
    if (!canManageLifecycle) return;
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
    if (!canManageLifecycle) return;
    setIsActionsOpen(false);
    setShowArchiveDialog(true);
  };

  const handleMarkLatestMessageRead = async () => {
    if (isMarkingLatestRead) return;
    setIsActionsOpen(false);
    setIsMarkingLatestRead(true);
    try {
      await onMarkLatestMessageRead(session.id);
    } catch (error) {
      console.error("Failed to mark session read", error);
    } finally {
      setIsMarkingLatestRead(false);
    }
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

    setIsRenaming(false);

    const success = await renameSession(trimmed);
    if (!success) {
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
        if (!canManageLifecycle && !session.readState.unread) return;
        longPressTriggeredRef.current = true;
        setIsActionsOpen(true);
      }, MOBILE_LONG_PRESS_MS);
    },
    [canManageLifecycle, clearLongPressTimer, isMobile, session.readState.unread]
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
              aria-label="Session title"
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
            <div className="flex items-center gap-1.5 text-sm text-foreground">
              {session.readState.unread && (
                <>
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  />
                  <span className="sr-only">Unread</span>
                </>
              )}
              {prDisplay && (
                <PullRequestStateIcon state={prDisplay.state} label={prDisplay.label} />
              )}
              <span
                className={`truncate ${session.readState.unread ? "font-semibold" : "font-medium"}`}
              >
                {displayTitle}
              </span>
              {session.status === "failed" && (
                <span className="shrink-0 text-xs font-medium text-destructive">Failed</span>
              )}
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

        {(canManageLifecycle || session.readState.unread) && (
          <div className="absolute inset-y-0 right-2 flex items-center">
            <DropdownMenu open={isActionsOpen} onOpenChange={setIsActionsOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Session actions"
                  aria-hidden={isMobile && !session.readState.unread ? "true" : undefined}
                  tabIndex={isMobile && !session.readState.unread ? -1 : undefined}
                  className={`items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition data-[state=open]:opacity-100 ${
                    isMobile
                      ? session.readState.unread
                        ? "flex h-10 w-10"
                        : "pointer-events-none flex h-6 w-6 opacity-0"
                      : "flex h-6 w-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
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
                {canManageLifecycle && (
                  <DropdownMenuItem onSelect={handleStartRename}>Rename</DropdownMenuItem>
                )}
                {session.readState.unread && (
                  <DropdownMenuItem
                    onSelect={handleMarkLatestMessageRead}
                    disabled={isMarkingLatestRead}
                  >
                    Mark as read
                  </DropdownMenuItem>
                )}
                {canManageLifecycle && (
                  <DropdownMenuItem onClick={handleStartArchive} disabled={isArchiving}>
                    <ArchiveIcon className="w-4 h-4" />
                    Archive
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {canManageLifecycle && (
        <ArchiveSessionDialog
          open={showArchiveDialog}
          onOpenChange={setShowArchiveDialog}
          onConfirm={handleConfirmArchive}
        />
      )}
    </>
  );
}

export function ChildSessionListItem({
  session,
  isActive,
  isMobile,
  onSessionSelect,
  depth,
  onMarkLatestMessageRead,
}: {
  session: SessionItem;
  isActive: boolean;
  isMobile: boolean;
  onSessionSelect?: () => void;
  depth: number;
  onMarkLatestMessageRead: (sessionId: string) => Promise<void>;
}) {
  const [isMarkingLatestRead, setIsMarkingLatestRead] = useState(false);
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const prDisplay = pullRequestSummaryDisplay(session.pullRequestSummary);
  const displayTitle = session.title || "Sub-task";
  const paddingLeftRem = 1.75 + Math.max(depth - 1, 0) * 1;
  const handleMarkLatestMessageRead = async () => {
    if (isMarkingLatestRead) return;
    setIsMarkingLatestRead(true);
    try {
      await onMarkLatestMessageRead(session.id);
    } catch (error) {
      console.error("Failed to mark session read", error);
    } finally {
      setIsMarkingLatestRead(false);
    }
  };
  return (
    <div className="group relative">
      <Link
        href={buildSessionHref(session)}
        onClick={() => {
          if (isMobile) onSessionSelect?.();
        }}
        className={`block pr-9 py-1.5 border-l-2 transition ${
          isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
        }`}
        style={{ paddingLeft: `${paddingLeftRem}rem` }}
      >
        <div className="flex items-center gap-1.5 text-xs">
          {session.readState.unread && (
            <>
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="sr-only">Unread</span>
            </>
          )}
          <span className="shrink-0 text-muted-foreground">{relativeTime}</span>
          {prDisplay && <PullRequestStateIcon state={prDisplay.state} label={prDisplay.label} />}
          <span
            className={`truncate text-foreground ${session.readState.unread ? "font-semibold" : "font-medium"}`}
          >
            {displayTitle}
          </span>
          {session.status === "failed" && (
            <span className="shrink-0 font-medium text-destructive">Failed</span>
          )}
        </div>
      </Link>
      {session.readState.unread && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Session actions"
              className={`absolute right-0 top-0 h-10 w-10 items-center justify-center text-muted-foreground ${
                isMobile
                  ? "flex"
                  : "invisible flex opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 data-[state=open]:visible data-[state=open]:opacity-100"
              }`}
            >
              <MoreIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={handleMarkLatestMessageRead} disabled={isMarkingLatestRead}>
              Mark as read
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
