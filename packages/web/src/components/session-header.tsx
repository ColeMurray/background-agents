"use client";

import { useEffect, useState, type RefObject } from "react";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import type { useSessionSocket } from "@/hooks/use-session-socket";
import { formatRepoLabel } from "@/lib/repo-label";

type SessionSocketState = ReturnType<typeof useSessionSocket>;

const SANDBOX_STATUS_COLORS: Record<string, string> = {
  pending: "text-muted-foreground",
  warming: "text-warning",
  spawning: "text-warning",
  syncing: "text-accent",
  ready: "text-success",
  running: "text-accent",
  stopped: "text-muted-foreground",
  stale: "text-muted-foreground",
  failed: "text-destructive",
};

export type SessionHeaderProps = {
  sessionState: SessionSocketState["sessionState"];
  fallbackSessionInfo: {
    repoOwner: string | null;
    repoName: string | null;
    title: string | null;
  };
  connected: boolean;
  connecting: boolean;
  isDetailsOpen: boolean;
  detailsButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleDetails: () => void;
  renameSession: (title: string) => Promise<boolean | undefined>;
};

export function SessionHeader({
  sessionState,
  fallbackSessionInfo,
  connected,
  connecting,
  isDetailsOpen,
  detailsButtonRef,
  onToggleDetails,
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
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null);

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

    const previousTitle = resolvedTitle;
    setIsRenaming(false);
    setOptimisticTitle(trimmed);

    const success = await renameSession(trimmed);
    if (!success) {
      setOptimisticTitle(null);
      setTitle(previousTitle);
      setIsRenaming(true);
    }
  };

  useEffect(() => {
    if (!optimisticTitle) return;
    if (sessionState?.title === optimisticTitle) {
      setOptimisticTitle(null);
    }
  }, [optimisticTitle, sessionState?.title]);

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
              <h1
                className="text-sm font-medium text-foreground max-w-40 truncate cursor-text"
                onClick={handleStartRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleStartRename();
                  }
                }}
                role="button"
                tabIndex={0}
                title="Click to rename"
              >
                {resolvedTitle}
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
            className="lg:hidden px-3 py-1.5 text-sm text-muted-foreground border border-border-muted hover:text-foreground hover:bg-muted transition"
            aria-label="Toggle session details"
            aria-controls="session-details-dialog"
            aria-expanded={isDetailsOpen}
          >
            Details
          </button>
          <div className="md:hidden">
            <CombinedStatusDot
              connected={connected}
              connecting={connecting}
              sandboxStatus={sessionState?.sandboxStatus}
            />
          </div>
          <div className="hidden md:contents">
            <ConnectionStatus connected={connected} connecting={connecting} />
            <SandboxStatus
              status={sessionState?.sandboxStatus}
              dashboardUrl={sessionState?.sandboxDashboardUrl}
            />
          </div>
        </div>
      </div>
    </header>
  );
}

function ConnectionStatus({ connected, connecting }: { connected: boolean; connecting: boolean }) {
  if (connecting) {
    return (
      <span className="flex items-center gap-1 text-xs text-warning">
        <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
        Connecting...
      </span>
    );
  }

  if (connected) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <span className="w-2 h-2 rounded-full bg-success" />
        Connected
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs text-destructive">
      <span className="w-2 h-2 rounded-full bg-destructive" />
      Disconnected
    </span>
  );
}

function SandboxStatus({
  status,
  dashboardUrl,
}: {
  status?: string;
  dashboardUrl?: string | null;
}) {
  if (!status) return null;

  const className = `text-xs ${SANDBOX_STATUS_COLORS[status] || SANDBOX_STATUS_COLORS.pending}`;
  const label = `Sandbox: ${status}`;

  if (dashboardUrl) {
    return (
      <a
        href={dashboardUrl}
        target="_blank"
        rel="noreferrer noopener"
        title="Open sandbox in provider dashboard"
        className={`${className} hover:underline`}
      >
        {label}
        <span aria-hidden="true" className="ml-0.5">
          {"\u2197"}
        </span>
      </a>
    );
  }

  return <span className={className}>{label}</span>;
}

function CombinedStatusDot({
  connected,
  connecting,
  sandboxStatus,
}: {
  connected: boolean;
  connecting: boolean;
  sandboxStatus?: string;
}) {
  let color: string;
  let pulse = false;
  let label: string;

  if (!connected && !connecting) {
    color = "bg-destructive";
    label = "Disconnected";
  } else if (connecting) {
    color = "bg-warning";
    pulse = true;
    label = "Connecting...";
  } else if (sandboxStatus === "failed") {
    color = "bg-destructive";
    label = `Connected \u00b7 Sandbox: ${sandboxStatus}`;
  } else if (["pending", "warming", "spawning", "syncing"].includes(sandboxStatus || "")) {
    color = "bg-warning";
    label = `Connected \u00b7 Sandbox: ${sandboxStatus}`;
  } else {
    color = "bg-success";
    label = sandboxStatus ? `Connected \u00b7 Sandbox: ${sandboxStatus}` : "Connected";
  }

  return (
    <span title={label} className="flex items-center">
      <span className={`w-2.5 h-2.5 rounded-full ${color}${pulse ? " animate-pulse" : ""}`} />
    </span>
  );
}
