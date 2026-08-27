"use client";

import { useEffect, useState, type RefObject } from "react";
import type { SandboxStatus as SandboxStatusValue } from "@open-inspect/shared/types/sessions";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { MobileSessionActions } from "@/components/mobile-session-actions";
import type { SessionActionProps } from "@/components/session-actions";
import { BoxIcon, RightSidebarIcon } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { useSessionSocket } from "@/hooks/use-session-socket";
import { formatRepoLabel } from "@/lib/repo-label";
import { getSafeExternalUrl } from "@/lib/urls";

type SessionSocketState = ReturnType<typeof useSessionSocket>;

const SANDBOX_STATUS_PRESENTATION: Record<
  SandboxStatusValue,
  { label: string; detail: string; color: string; dot: string; pulse?: boolean }
> = {
  pending: {
    label: "Pending",
    detail: "Waiting for the sandbox to start.",
    color: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  warming: {
    label: "Warming...",
    detail: "Preparing sandbox capacity.",
    color: "text-warning",
    dot: "bg-warning",
    pulse: true,
  },
  spawning: {
    label: "Starting...",
    detail: "Creating or restoring the sandbox.",
    color: "text-warning",
    dot: "bg-warning",
    pulse: true,
  },
  connecting: {
    label: "Connecting...",
    detail: "Waiting for the sandbox runtime to connect.",
    color: "text-warning",
    dot: "bg-warning",
    pulse: true,
  },
  ready: {
    label: "Ready",
    detail: "The sandbox is available.",
    color: "text-success",
    dot: "bg-success",
  },
  snapshotting: {
    label: "Saving...",
    detail: "Saving a sandbox snapshot.",
    color: "text-accent",
    dot: "bg-accent",
    pulse: true,
  },
  stopped: {
    label: "Stopped",
    detail: "The sandbox stopped after inactivity and can restart with the next prompt.",
    color: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  stale: {
    label: "Unresponsive",
    detail: "The sandbox runtime stopped responding.",
    color: "text-destructive",
    dot: "bg-destructive",
  },
  failed: {
    label: "Failed",
    detail: "The sandbox could not start or recover.",
    color: "text-destructive",
    dot: "bg-destructive",
  },
};

export type SessionHeaderProps = {
  sessionState: SessionSocketState["sessionState"];
  /** Why the sandbox last failed; shown in the status popover. */
  sandboxError?: SessionSocketState["sandboxError"];
  fallbackSessionInfo: {
    repoOwner: string | null;
    repoName: string | null;
    title: string | null;
  };
  connected: boolean;
  connecting: boolean;
  isDetailsOpen: boolean;
  isDesktopDetailsOpen: boolean;
  showDesktopDetailsToggle: boolean;
  detailsButtonRef: RefObject<HTMLButtonElement | null>;
  actionsButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleDetails: () => void;
  onToggleDesktopDetails: () => void;
  onOpenMobileDetails: () => void;
  actions: SessionActionProps;
  optimisticTitle?: string;
  renameSession: (title: string) => Promise<boolean>;
};

export function SessionHeader({
  sessionState,
  sandboxError,
  fallbackSessionInfo,
  connected,
  connecting,
  isDetailsOpen,
  isDesktopDetailsOpen,
  showDesktopDetailsToggle,
  detailsButtonRef,
  actionsButtonRef,
  onToggleDetails,
  onToggleDesktopDetails,
  onOpenMobileDetails,
  actions,
  optimisticTitle,
  renameSession,
}: SessionHeaderProps) {
  const { isOpen } = useSidebarContext();
  const hasFallbackSessionInfo =
    fallbackSessionInfo.repoOwner !== null ||
    fallbackSessionInfo.repoName !== null ||
    fallbackSessionInfo.title !== null;
  const repoLabel = sessionState
    ? formatRepoLabel(sessionState.repoOwner, sessionState.repoName)
    : hasFallbackSessionInfo
      ? formatRepoLabel(fallbackSessionInfo.repoOwner, fallbackSessionInfo.repoName)
      : "Loading session...";
  const baseResolvedTitle = sessionState?.title ?? fallbackSessionInfo.title ?? repoLabel;

  const [isRenaming, setIsRenaming] = useState(false);
  const [title, setTitle] = useState(baseResolvedTitle);
  const resolvedTitle =
    optimisticTitle ?? sessionState?.title ?? fallbackSessionInfo.title ?? repoLabel;

  const handleStartRename = () => {
    setTitle(resolvedTitle);
    setIsRenaming(true);
  };

  const handleRenameSubmit = async () => {
    if (!sessionState) {
      setIsRenaming(false);
      return;
    }

    const trimmed = title.trim();

    if (!trimmed || trimmed === resolvedTitle) {
      setIsRenaming(false);
      return;
    }

    setIsRenaming(false);

    const success = await renameSession(trimmed);
    if (!success) {
      setIsRenaming(true);
    }
  };

  useEffect(() => {
    if (!isRenaming) setTitle(sessionState?.title ?? fallbackSessionInfo.title ?? "");
  }, [fallbackSessionInfo.title, sessionState?.title, isRenaming]);

  return (
    <header className="border-b border-border-muted flex-shrink-0">
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {!isOpen && <CollapsedSidebarControls />}
          <div>
            {isRenaming ? (
              <input
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
                    setIsRenaming(false);
                  }
                }}
                className="text-sm bg-transparent text-foreground outline-none focus:ring-inset focus:ring-ring font-medium max-w-40 truncate"
              />
            ) : (
              <h1 className="max-w-40 truncate text-sm font-medium text-foreground">
                <button
                  type="button"
                  className="max-w-full truncate cursor-text text-left"
                  onClick={handleStartRename}
                  title="Click to rename"
                >
                  {resolvedTitle}
                </button>
              </h1>
            )}
            <p className="text-sm text-muted-foreground">{repoLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button
            ref={detailsButtonRef}
            type="button"
            onClick={onToggleDetails}
            className="hidden md:block lg:hidden px-3 py-1.5 text-sm text-muted-foreground border border-border-muted hover:text-foreground hover:bg-muted transition"
            aria-label="Toggle session details"
            aria-controls="session-details-dialog"
            aria-expanded={isDetailsOpen}
          >
            Details
          </button>
          <MobileSessionActions
            {...actions}
            triggerRef={actionsButtonRef}
            onOpenDetails={onOpenMobileDetails}
            onOpenMedia={onOpenMobileDetails}
          />
          <div className="flex items-center gap-1">
            <ConnectionStatusIcon connected={connected} connecting={connecting} />
            <SandboxStatusIcon
              status={sessionState?.sandboxStatus}
              dashboardUrl={sessionState?.sandboxDashboardUrl}
              error={sandboxError}
            />
          </div>
          {showDesktopDetailsToggle && (
            <button
              type="button"
              onClick={onToggleDesktopDetails}
              className="hidden rounded p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground lg:block"
              aria-label={isDesktopDetailsOpen ? "Hide session details" : "Show session details"}
              aria-controls="session-details-sidebar"
              aria-expanded={isDesktopDetailsOpen}
            >
              <RightSidebarIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function ConnectionStatusIcon({
  connected,
  connecting,
}: {
  connected: boolean;
  connecting: boolean;
}) {
  const label = connecting ? "Connecting..." : connected ? "Connected" : "Disconnected";
  const color = connecting ? "bg-warning" : connected ? "bg-success" : "bg-destructive";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="status"
            aria-label={`Connection status: ${label}`}
            tabIndex={0}
            className="flex h-8 w-8 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-full ${color}${connecting ? " animate-pulse motion-reduce:animate-none" : ""}`}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SandboxStatusIcon({
  status,
  dashboardUrl,
  error,
}: {
  status?: SandboxStatusValue;
  dashboardUrl?: string | null;
  /**
   * The control plane's reason for the current failure, when it has one.
   * Rendered verbatim: it is usually the sandbox provider's own message (quota
   * exceeded, rate limited, timeout above the plan cap), which is the only part
   * that tells someone what to actually change.
   */
  error?: string | null;
}) {
  if (!status) return null;

  const presentation = SANDBOX_STATUS_PRESENTATION[status];
  const safeDashboardUrl = getSafeExternalUrl(dashboardUrl);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Sandbox status: ${presentation.label}`}
          className={`relative flex h-8 w-8 items-center justify-center rounded-sm border border-border ${presentation.color} transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        >
          <BoxIcon className="h-4 w-4" />
          <span
            aria-hidden="true"
            className={`absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ${presentation.dot}${presentation.pulse ? " animate-pulse motion-reduce:animate-none" : ""}`}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-[min(20rem,calc(100vw-2rem))] p-0">
        <div className="border-b border-border-muted p-3">
          <div className={`flex items-center gap-2 text-sm font-medium ${presentation.color}`}>
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${presentation.dot}${presentation.pulse ? " animate-pulse motion-reduce:animate-none" : ""}`}
            />
            Sandbox {presentation.label}
          </div>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{presentation.detail}</p>
          {error && (
            <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-2 font-mono text-[11px] leading-4 text-destructive">
              {error}
            </p>
          )}
        </div>
        {safeDashboardUrl && (
          <a
            href={safeDashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between p-3 text-xs font-medium text-accent hover:bg-muted"
          >
            Open provider dashboard
            <span aria-hidden="true">{"\u2197"}</span>
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}
