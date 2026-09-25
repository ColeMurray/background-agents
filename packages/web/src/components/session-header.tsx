"use client";

import { useEffect, useState, type RefObject } from "react";
import type { BootPhaseName, SandboxBootPhase } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxShutdownState } from "@open-inspect/shared/types/sandbox-shutdown";
import type { SandboxStatus as SandboxStatusValue } from "@open-inspect/shared/types/sessions";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { MobileSessionActions } from "@/components/mobile-session-actions";
import type { SessionActionProps } from "@/components/session-actions";
import {
  BoxIcon,
  ChevronRightIcon,
  RightSidebarIcon,
  RightSidebarOpenIcon,
} from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { useSessionSocket } from "@/hooks/use-session-socket";
import { formatRepoLabel } from "@/lib/repo-label";
import { SANDBOX_STATUS_PRESENTATION } from "@/lib/sandbox-status-presentation";
import { bootPhaseLabel, bootPhaseRepoLabel } from "@/lib/session-socket/boot-phase";
import { getSafeExternalUrl } from "@/lib/urls";
import type { SessionCapabilities } from "@/lib/session-capabilities";

type SessionSocketState = ReturnType<typeof useSessionSocket>;

/** Statuses during which the runtime reports boot phases. */
const BOOTING_STATUSES: ReadonlySet<SandboxStatusValue> = new Set(["spawning", "connecting"]);

/**
 * The one sandbox state that needs no explaining. Anything else — booting,
 * saving, stopped, broken — gets a line of its own on mobile, so the only
 * state the phone stays silent about is the one where there is nothing to
 * say. Full detail is always in the actions menu regardless.
 */
const STEADY_SANDBOX_STATUS: SandboxStatusValue = "ready";

/**
 * Graceful-stop phases. The control plane keeps the sandbox `ready` until the
 * stop finishes, but new prompts are already held while it saves, so the
 * header reports a save rather than a sandbox that is available.
 */
const GRACEFUL_STOP_PHASES: ReadonlySet<SandboxShutdownState["phase"]> = new Set([
  "draining",
  "prepared",
  "capturing",
  "retiring",
]);

function displayedSandboxStatus(
  sessionState: SessionSocketState["sessionState"]
): SandboxStatusValue | undefined {
  const status = sessionState?.sandboxStatus;
  const phase = sessionState?.sandboxPreservation?.phase;
  return status === "ready" && phase && GRACEFUL_STOP_PHASES.has(phase) ? "snapshotting" : status;
}

type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected";

/**
 * A pending reconnect is a wait, not a dead connection: say so rather than
 * showing "Disconnected" while the backoff timer runs. That backoff spans
 * minutes (MAX_RECONNECT_ATTEMPTS in use-session-transport), which is far too
 * long for the interface to say nothing.
 */
const CONNECTION_PRESENTATION: Record<
  ConnectionState,
  { label: string; dot: string; pulse?: boolean }
> = {
  connected: { label: "Connected", dot: "bg-success" },
  connecting: { label: "Connecting...", dot: "bg-warning", pulse: true },
  reconnecting: { label: "Reconnecting...", dot: "bg-warning", pulse: true },
  disconnected: { label: "Disconnected", dot: "bg-destructive" },
};

function connectionState(
  connected: boolean,
  connecting: boolean,
  reconnecting: boolean
): ConnectionState {
  if (reconnecting) return "reconnecting";
  if (connecting) return "connecting";
  return connected ? "connected" : "disconnected";
}

/**
 * What a phase report means for the popover, by the report's status. Copy
 * omits the trailing period so a repository can follow. A `started` report
 * also relabels the pill; a `completed` one keeps the sandbox status label,
 * since the runtime is between steps, and says what just finished.
 */
const BOOT_PHASE_DETAILS: Record<BootPhaseName, { started: string; completed: string }> = {
  starting: {
    started: "The sandbox runtime is up and the boot is starting",
    completed: "The sandbox runtime is up",
  },
  sync: { started: "Cloning the repository", completed: "Cloned the repository" },
  setup: { started: "Running setup.sh", completed: "Finished setup.sh" },
  start: { started: "Running start.sh", completed: "Finished start.sh" },
  skills: { started: "Installing skills", completed: "Installed skills" },
  harness: { started: "Starting the agent", completed: "Started the agent" },
};

const BOOT_WARNING_DETAIL = "This step exited with an error and the boot continued.";

function describeBootPhase(
  bootPhase: SandboxBootPhase,
  repositoryCount: number
): { label?: string; detail: string } | null {
  if (bootPhase.status === "failed") return null;
  const repo = bootPhaseRepoLabel(bootPhase, repositoryCount);
  const detail = `${BOOT_PHASE_DETAILS[bootPhase.phase][bootPhase.status]}${repo ? ` for ${repo}` : ""}.`;
  return {
    ...(bootPhase.status === "started" ? { label: bootPhaseLabel(bootPhase.phase) } : {}),
    detail: bootPhase.warning ? `${detail} ${BOOT_WARNING_DETAIL}` : detail,
  };
}

export type SessionHeaderProps = {
  sessionState: SessionSocketState["sessionState"];
  /** Why the sandbox last failed; shown in the status popover. */
  sandboxError?: SessionSocketState["sandboxError"];
  /** The boot phase a booting or failed sandbox last reported. */
  bootPhase?: SandboxBootPhase | null;
  fallbackSessionInfo: {
    repoOwner: string | null;
    repoName: string | null;
    title: string | null;
  };
  connected: boolean;
  connecting: boolean;
  /** A reconnect is scheduled and has not started yet. */
  reconnecting: boolean;
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
  capabilities: SessionCapabilities;
};

export function SessionHeader({
  sessionState,
  sandboxError,
  bootPhase,
  fallbackSessionInfo,
  connected,
  connecting,
  reconnecting,
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
  capabilities,
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
    if (!capabilities.lifecycle) return;
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

  // Mobile shows the title and nothing else: no repository, no status pill.
  // Anything worth reporting goes in the strip below, as text rather than a
  // decorative dot, and the full detail is always in the actions menu.
  // Desktop keeps the full header.
  const sandboxStatus = displayedSandboxStatus(sessionState);
  const sandbox = sandboxStatus
    ? resolveSandboxStatus({
        status: sandboxStatus,
        dashboardUrl: capabilities.sandboxAccess ? sessionState?.sandboxDashboardUrl : undefined,
        error: sandboxError,
        bootPhase,
        repositoryCount: sessionState?.repositories?.length ?? 0,
      })
    : null;

  return (
    <header className="border-b border-border-muted flex-shrink-0">
      <div className="flex h-12 items-center justify-between gap-1 px-2 md:h-auto md:gap-0 md:px-4 md:py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-initial">
          {!isOpen && <CollapsedSidebarControls />}
          <div className="min-w-0 flex-1 md:flex-initial">
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
                className="w-full truncate bg-transparent text-center text-sm font-medium text-foreground outline-none focus:ring-inset focus:ring-ring md:max-w-40 md:text-left"
              />
            ) : (
              <h1 className="flex min-w-0 items-center justify-center text-sm font-medium text-foreground md:max-w-40 md:justify-start">
                <button
                  type="button"
                  className={`min-w-0 truncate ${capabilities.lifecycle ? "cursor-text" : "cursor-default"}`}
                  onClick={handleStartRename}
                  title={capabilities.lifecycle ? "Click to rename" : undefined}
                  disabled={!capabilities.lifecycle}
                >
                  {resolvedTitle}
                </button>
              </h1>
            )}
            <p className="hidden text-sm text-muted-foreground md:block">{repoLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 md:gap-4">
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
            sandbox={sandbox}
            triggerRef={actionsButtonRef}
            onOpenDetails={onOpenMobileDetails}
            onOpenMedia={onOpenMobileDetails}
          />
          <div className="hidden items-center gap-1 md:flex">
            {capabilities.read && (
              <ConnectionStatusIcon
                connected={connected}
                connecting={connecting}
                reconnecting={reconnecting}
              />
            )}
            <SandboxStatusIcon
              status={sandboxStatus}
              dashboardUrl={
                capabilities.sandboxAccess ? sessionState?.sandboxDashboardUrl : undefined
              }
              error={sandboxError}
              bootPhase={bootPhase}
              repositoryCount={sessionState?.repositories?.length ?? 0}
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
              {isDesktopDetailsOpen ? (
                <RightSidebarOpenIcon className="h-4 w-4" />
              ) : (
                <RightSidebarIcon className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>
      <MobileStatusStrip
        connection={
          capabilities.read ? connectionState(connected, connecting, reconnecting) : "connected"
        }
        status={sandboxStatus}
        dashboardUrl={capabilities.sandboxAccess ? sessionState?.sandboxDashboardUrl : undefined}
        error={sandboxError}
        bootPhase={bootPhase}
        repositoryCount={sessionState?.repositories?.length ?? 0}
      />
    </header>
  );
}

function ConnectionStatusIcon({
  connected,
  connecting,
  reconnecting,
}: {
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
}) {
  const { label, dot, pulse } =
    CONNECTION_PRESENTATION[connectionState(connected, connecting, reconnecting)];

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
              className={`h-2.5 w-2.5 rounded-full ${dot}${pulse ? " animate-pulse motion-reduce:animate-none" : ""}`}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type SandboxStatusProps = {
  status?: SandboxStatusValue;
  dashboardUrl?: string | null;
  /**
   * The control plane's reason for the current failure, when it has one.
   * Rendered verbatim: it is usually the sandbox provider's own message (quota
   * exceeded, rate limited, timeout above the plan cap), which is the only part
   * that tells someone what to actually change.
   */
  error?: string | null;
  /**
   * The runtime's last boot phase. While the sandbox boots it names the step
   * in progress instead of a generic "Starting..."; after a failure it names
   * the step that broke.
   */
  bootPhase?: SandboxBootPhase | null;
  /** Members of the session; phases name their repository only when there are several. */
  repositoryCount: number;
};

/**
 * Everything the status surfaces need to say, resolved once. The desktop icon
 * and the mobile strip are different shapes around this same answer, so the
 * two cannot drift apart.
 */
function resolveSandboxStatus({
  status,
  dashboardUrl,
  error,
  bootPhase,
  repositoryCount,
}: SandboxStatusProps & { status: SandboxStatusValue }) {
  const booting =
    bootPhase && BOOTING_STATUSES.has(status)
      ? describeBootPhase(bootPhase, repositoryCount)
      : null;
  const failedPhase = status === "failed" && bootPhase?.status === "failed" ? bootPhase : null;
  const failedPhaseRepo = failedPhase ? bootPhaseRepoLabel(failedPhase, repositoryCount) : null;
  return {
    presentation: booting
      ? { ...SANDBOX_STATUS_PRESENTATION[status], ...booting }
      : SANDBOX_STATUS_PRESENTATION[status],
    // Built once: the popover and the mobile actions menu both say which step
    // broke, and a failure reachable from only one of them is no better than
    // one reachable from neither.
    failedPhaseSummary: failedPhase
      ? `Failed while ${bootPhaseLabel(failedPhase.phase).toLowerCase()}${failedPhaseRepo ? ` for ${failedPhaseRepo}` : ""}.`
      : null,
    reason: error ?? failedPhase?.detail,
    safeDashboardUrl: getSafeExternalUrl(dashboardUrl),
  };
}

export type ResolvedSandboxStatus = ReturnType<typeof resolveSandboxStatus>;

function SandboxStatusDetail({
  presentation,
  failedPhaseSummary,
  reason,
  safeDashboardUrl,
}: ResolvedSandboxStatus) {
  return (
    <>
      <div className="border-b border-border-muted p-3">
        <div className={`flex items-center gap-2 text-sm font-medium ${presentation.color}`}>
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${presentation.dot}${presentation.pulse ? " animate-pulse motion-reduce:animate-none" : ""}`}
          />
          Sandbox {presentation.label}
        </div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{presentation.detail}</p>
        {failedPhaseSummary && (
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{failedPhaseSummary}</p>
        )}
        {reason && (
          <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-2 font-mono text-[11px] leading-4 text-destructive">
            {reason}
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
    </>
  );
}

function SandboxStatusIcon(props: SandboxStatusProps) {
  const { status } = props;
  if (!status) return null;

  const resolved = resolveSandboxStatus({ ...props, status });
  const { presentation } = resolved;

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
        <SandboxStatusDetail {...resolved} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The mobile header's glanceable status line. It appears below the title
 * whenever there is something to report and stays out of the way when there
 * is not, so the common case keeps the bare title bar.
 *
 * The socket wins over the sandbox: a connection that is down or retrying
 * means the sandbox status on screen may no longer be true, and a silent
 * header during a reconnect that can run for minutes reads as a frozen app.
 */
function MobileStatusStrip({
  connection,
  ...statusProps
}: SandboxStatusProps & { connection: ConnectionState }) {
  const { status } = statusProps;
  const connectionPresentation =
    connection === "connected" ? null : CONNECTION_PRESENTATION[connection];
  const resolved =
    !connectionPresentation && status && status !== STEADY_SANDBOX_STATUS
      ? resolveSandboxStatus({ ...statusProps, status })
      : null;

  // The live region stays mounted even with nothing to report. A region
  // inserted in the same commit as its first text is commonly not announced,
  // so it has to already exist when the text arrives — which is the whole
  // point of it on a header that is silent most of the time.
  return (
    <div role="status" className="md:hidden">
      {connectionPresentation && (
        <p
          className={`flex items-center gap-2 border-t border-border-muted px-3 py-2 text-xs ${
            connection === "disconnected" ? "text-destructive" : "text-warning"
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${connectionPresentation.dot}${connectionPresentation.pulse ? " animate-pulse motion-reduce:animate-none" : ""}`}
          />
          {connectionPresentation.label}
        </p>
      )}
      {resolved && <MobileSandboxStatus resolved={resolved} />}
    </div>
  );
}

function MobileSandboxStatus({ resolved }: { resolved: ResolvedSandboxStatus }) {
  const { presentation } = resolved;

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Show sandbox status: ${presentation.label}`}
            className={`flex w-full items-center gap-2 border-t border-border-muted px-3 py-2 text-left text-xs ${presentation.color} transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${presentation.dot}`}
            />
            <span className="min-w-0 flex-1 truncate">Sandbox {presentation.label}</span>
            <ChevronRightIcon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          side="bottom"
          className="w-[min(20rem,calc(100vw-2rem))] p-0"
        >
          <SandboxStatusDetail {...resolved} />
        </PopoverContent>
      </Popover>
    </>
  );
}
