"use client";

import { SessionProjectControl } from "./projects/session-project-control";
import { useMemo, useState, type ReactNode } from "react";
import { CollapsibleSection } from "./sidebar/collapsible-section";
import { ParticipantsSection } from "./sidebar/participants-section";
import { MetadataSection } from "./sidebar/metadata-section";
import { TasksSection } from "./sidebar/tasks-section";
import { FilesChangedSection } from "./sidebar/files-changed-section";
import { MediaSection } from "./sidebar/media-section";
import { CodeServerSection } from "./sidebar/code-server-section";
import { VncSection } from "./sidebar/vnc-section";
import { TunnelUrlsSection } from "./sidebar/tunnel-urls-section";
import { ChildSessionsSection } from "./sidebar/child-sessions-section";
import { TerminalIcon, LinkIcon } from "@/components/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildAuthenticatedUrl } from "@/lib/urls";
import { extractLatestTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { ParticipantPresence, SessionState } from "@open-inspect/shared/types/server-messages";
import type {
  SessionDiffFile,
  SessionDiffRepository,
  SessionDiffState,
} from "@open-inspect/shared/types/session-diffs";
import type { DiffSelection } from "@/lib/session-diffs";
import { deriveSessionDiffView } from "@/lib/session-diffs";
import { DiffRetryNotice } from "@/components/diff-retry-notice";
import { ManagedSkillsSection } from "./sidebar/managed-skills-section";
import { BudgetSection } from "./sidebar/budget-section";
import { DetailsSection } from "./sidebar/details-section";
import type { SessionCapabilities } from "@/lib/session-capabilities";
import {
  SESSION_INSPECTOR_TABS,
  isSessionInspectorTab,
  type SessionInspectorTab,
} from "@/hooks/use-session-inspector-tab";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";
import { toast } from "sonner";
import type { SessionScopeControls } from "@/lib/session-scope";
import { SessionVisibilityControl } from "./session-visibility-control";
import { CollaboratorsSection } from "./sidebar/collaborators-section";

interface SessionRightSidebarProps {
  isOpen?: boolean;
  sessionId: string;
  sessionState: SessionState | null;
  participants: ParticipantPresence[];
  presenceSynced: boolean;
  events: SandboxEvent[];
  artifacts: Artifact[];
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  onOpenMedia: (artifactId: string) => void;
  diffState?: SessionDiffState | null;
  diffLoading?: boolean;
  selectedDiff?: DiffSelection | null;
  onOpenDiff?: (repository: SessionDiffRepository, file: SessionDiffFile) => void;
  capabilities: SessionCapabilities;
  scope?: SessionScopeControls;
  canManageBudget?: boolean;
  /** The session page owns the tab so the diff view can tell whether the file list is showing. */
  activeTab: SessionInspectorTab;
  onTabChange: (tab: SessionInspectorTab) => void;
}

export type SessionRightSidebarContentProps = SessionRightSidebarProps;

const DEFAULT_CAN_MANAGE_BUDGET = false;
const TRACE_DOWNLOAD_TIMEOUT_MS = 60_000;

const INSPECTOR_TAB_LABELS: Record<SessionInspectorTab, string> = {
  info: "Info",
  changes: "Changes",
  tasks: "Tasks",
  tools: "Tools",
};

function InspectorPanel({
  value,
  activeTab,
  className,
  children,
}: {
  value: SessionInspectorTab;
  activeTab: SessionInspectorTab;
  className?: string;
  children: ReactNode;
}) {
  // Inactive panels stay mounted so file filters and section state survive tab switches.
  // Each panel scrolls on its own, so switching tabs never lands partway down another list.
  return (
    <TabsContent
      value={value}
      forceMount
      hidden={value !== activeTab}
      className={cn("min-h-0 flex-1 overflow-y-auto p-5", className)}
    >
      {children}
    </TabsContent>
  );
}

export function SessionRightSidebarContent({
  sessionId,
  sessionState,
  participants,
  presenceSynced,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
  diffState,
  diffLoading,
  selectedDiff,
  onOpenDiff,
  canManageBudget = DEFAULT_CAN_MANAGE_BUDGET,
  capabilities,
  activeTab,
  onTabChange,
  scope,
}: SessionRightSidebarContentProps) {
  const [downloading, setDownloading] = useState(false);
  const tasks = useMemo(() => extractLatestTasks(events), [events]);
  const warnings = useMemo(
    () =>
      events.filter(
        (event): event is Extract<SandboxEvent, { type: "warning" }> => event.type === "warning"
      ),
    [events]
  );
  const mediaArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.type === "screenshot" || artifact.type === "video"),
    [artifacts]
  );
  const terminalUrl = useMemo(
    () => buildAuthenticatedUrl(sessionState?.ttydUrl, sessionState?.ttydToken),
    [sessionState?.ttydUrl, sessionState?.ttydToken]
  );
  const hasRepository = Boolean(
    sessionState?.repositories?.length || (sessionState?.repoOwner && sessionState.repoName)
  );
  const diffView = deriveSessionDiffView({
    hasRepository,
    isProcessing: sessionState?.isProcessing ?? false,
    state: diffState ?? null,
    isLoading: diffLoading ?? false,
  });
  const files = diffView.showManifest
    ? (diffState?.current?.repositories.flatMap((repository) => repository.files) ?? [])
    : [];
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const hasSandboxTools =
    capabilities.sandboxAccess &&
    Boolean(
      sessionState?.codeServerUrl ||
      sessionState?.vncUrl ||
      terminalUrl ||
      Object.keys(sessionState?.tunnelUrls ?? {}).length
    );

  const downloadTrace = async () => {
    setDownloading(true);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TRACE_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await browserApiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/export`,
        { signal: controller.signal }
      );
      if (!response.ok) {
        toast.error(await sessionActionErrorMessage(response, "Failed to download trace"));
        return;
      }

      const blob = await response.blob();
      // Trace read and stream failures arrive as NDJSON records inside a 200 response.
      const failed = (await blob.text()).split("\n").some((line) => {
        if (!line) return false;
        const { type } = JSON.parse(line) as { type?: unknown };
        return type === "session_error" || type === "error";
      });
      if (failed) throw new Error("Trace export failed");

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `session-${sessionId}.ndjson`;
      document.body.append(link);
      link.click();
      link.remove();
      const revoke = URL.revokeObjectURL.bind(URL);
      setTimeout(() => revoke(url), 0);
    } catch {
      toast.error("Failed to download trace");
    } finally {
      clearTimeout(timeoutId);
      setDownloading(false);
    }
  };

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        if (isSessionInspectorTab(value)) onTabChange(value);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList aria-label="Session inspector" className="shrink-0 bg-background px-2">
        {SESSION_INSPECTOR_TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab}>
            {INSPECTOR_TAB_LABELS[tab]}{" "}
            {tab === "changes" && files.length > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground">{files.length}</span>
            )}
            {tab === "tasks" && tasks.length > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground">{tasks.length}</span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Canonical durable checkout changes */}
      <InspectorPanel value="changes" activeTab={activeTab}>
        <div className="mb-5">
          <h3 className="text-sm font-semibold">Files changed</h3>
          {files.length > 0 && (
            <div className="mt-3 flex items-baseline gap-3 font-mono text-lg tabular-nums">
              <span className="text-success">+{additions}</span>
              <span className="text-destructive">−{deletions}</span>
              <span className="font-sans text-xs text-muted-foreground">
                across {files.length} {files.length === 1 ? "file" : "files"}
              </span>
            </div>
          )}
        </div>
        {diffView.showManifest && diffState?.current && onOpenDiff && (
          <FilesChangedSection
            repositories={diffState.current.repositories}
            selected={selectedDiff}
            onSelect={onOpenDiff}
          />
        )}
        <div role="status" aria-live="polite" className={diffView.showManifest ? "mt-2" : ""}>
          {!sessionState ? (
            <p className="text-xs text-muted-foreground">Loading session information…</p>
          ) : diffView.kind === "hidden" ? (
            <p className="text-xs text-muted-foreground">
              No repository is attached to this session.
            </p>
          ) : null}
          {sessionState && diffView.kind === "loading" && (
            <p className="text-xs text-muted-foreground">Loading changes…</p>
          )}
          {diffView.kind === "error" && (
            <p className="text-xs text-destructive">Unable to load changes.</p>
          )}
          {diffView.kind === "unavailable" && (
            <p className="text-xs text-muted-foreground">{diffView.message}</p>
          )}
          {diffView.kind === "available_after_execution" && (
            <p className="text-xs text-muted-foreground">
              Changes will be available after the first execution.
            </p>
          )}
          {diffView.kind === "working" && (
            <p className="text-xs text-muted-foreground">
              {diffView.showManifest
                ? "Agent working — showing the previous changes."
                : "Changes will be available after this execution."}
            </p>
          )}
          {diffView.kind === "empty" && (
            <p className="text-xs text-muted-foreground">No file changes in the latest diff.</p>
          )}
          {diffView.kind === "failed" && (
            <DiffRetryNotice
              sessionId={sessionId}
              message={diffView.message ?? ""}
              variant="inline"
              capabilities={capabilities}
            />
          )}
        </div>
      </InspectorPanel>

      <InspectorPanel value="info" activeTab={activeTab} className="space-y-6">
        {sessionState ? (
          <>
            <MetadataSection
              sessionId={sessionId}
              createdAt={sessionState.createdAt}
              model={sessionState.model}
              reasoningEffort={sessionState.reasoningEffort}
              baseBranch={sessionState.baseBranch}
              branchName={sessionState.branchName || undefined}
              repoOwner={sessionState.repoOwner}
              repoName={sessionState.repoName}
              artifacts={artifacts}
              repositories={sessionState.repositories}
              environmentId={sessionState.environmentId}
              environmentName={sessionState.environmentName}
              warnings={warnings}
              parentSessionId={sessionState.parentSessionId}
              canManageLifecycle={capabilities.lifecycle}
              ownerTeamId={scope?.ownerTeamId}
              visibility={scope?.visibility}
            >
              <BudgetSection
                sessionId={sessionId}
                totalCost={sessionState.totalCost ?? 0}
                maxSessionCostUsd={sessionState.maxSessionCostUsd}
                canManageBudget={canManageBudget}
              />
            </MetadataSection>
            {/* Media the agent captured */}
            {mediaArtifacts.length > 0 && (
              <CollapsibleSection title={`Artifacts (${mediaArtifacts.length})`}>
                <MediaSection
                  sessionId={sessionId}
                  mediaArtifacts={mediaArtifacts}
                  onOpenMedia={onOpenMedia}
                />
              </CollapsibleSection>
            )}
            {scope && capabilities.changeVisibility && (
              <SessionVisibilityControl
                {...scope}
                sessionId={sessionId}
                canChangeVisibility={capabilities.changeVisibility}
              />
            )}
            {scope?.visibility === "private" && capabilities.manageCollaborators && (
              <CollaboratorsSection
                {...scope}
                sessionId={sessionId}
                canManageCollaborators={capabilities.manageCollaborators}
              />
            )}
            <SessionProjectControl sessionId={sessionId} canAssociate={capabilities.lifecycle} />
            <ManagedSkillsSection sessionId={sessionState.id} />
            {(!presenceSynced || participants.length > 0) && (
              <DetailsSection title="Participants">
                <ParticipantsSection participants={participants} presenceSynced={presenceSynced} />
              </DetailsSection>
            )}
            {capabilities.exportTrace && (
              <div>
                <button
                  type="button"
                  onClick={() => void downloadTrace()}
                  disabled={downloading}
                  className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                >
                  Download trace
                </button>
              </div>
            )}
          </>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            Loading session information…
          </p>
        )}
      </InspectorPanel>

      <InspectorPanel value="tasks" activeTab={activeTab} className="space-y-5">
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Agent plan</h3>
            {tasks.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {completedTasks} / {tasks.length} complete
              </span>
            )}
          </div>
          {tasks.length > 0 && (
            <progress
              aria-label="Completed tasks"
              value={completedTasks}
              max={tasks.length}
              className="mt-4 h-1 w-full overflow-hidden bg-muted [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-accent"
            />
          )}
        </div>
        {tasks.length > 0 ? (
          <TasksSection tasks={tasks} />
        ) : (
          <p className="text-xs text-muted-foreground">
            The agent hasn’t published a task list yet.
          </p>
        )}
        {sessionState && <ChildSessionsSection sessionId={sessionState.id} />}
      </InspectorPanel>

      <InspectorPanel value="tools" activeTab={activeTab} className="space-y-5">
        <h3 className="text-sm font-semibold">Workspace tools</h3>
        {!hasSandboxTools && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {!sessionState
              ? "Loading workspace tools…"
              : !capabilities.sandboxAccess
                ? "Sandbox access is not available with your permissions."
                : "Sandbox tools will appear here when available."}
          </p>
        )}

        {/* Code Server */}
        {capabilities.sandboxAccess && sessionState?.codeServerUrl && (
          <CodeServerSection
            url={sessionState.codeServerUrl}
            password={sessionState.codeServerPassword ?? null}
            sandboxStatus={sessionState.sandboxStatus}
          />
        )}

        {/* VNC Desktop */}
        {capabilities.sandboxAccess && sessionState?.vncUrl && (
          <VncSection
            url={sessionState.vncUrl}
            password={sessionState.vncPassword ?? null}
            sandboxStatus={sessionState.sandboxStatus}
          />
        )}

        {/* Terminal */}
        {capabilities.sandboxAccess && sessionState?.ttydUrl && terminalUrl && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TerminalIcon className="h-4 w-4" />
              <span className="font-medium">Terminal</span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={terminalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 text-muted-foreground hover:text-foreground transition"
                title="Open in new tab"
              >
                <LinkIcon className="h-3.5 w-3.5" />
              </a>
              {onToggleTerminal && (
                <button
                  type="button"
                  onClick={onToggleTerminal}
                  className="text-xs text-accent hover:underline"
                >
                  {terminalOpen ? "Hide" : "Show"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Tunnel URLs */}
        {capabilities.sandboxAccess &&
          sessionState?.tunnelUrls &&
          Object.keys(sessionState.tunnelUrls).length > 0 && (
            <TunnelUrlsSection
              urls={sessionState.tunnelUrls}
              sandboxStatus={sessionState.sandboxStatus}
            />
          )}
      </InspectorPanel>
    </Tabs>
  );
}

export function SessionRightSidebar({ isOpen = true, ...props }: SessionRightSidebarProps) {
  return (
    <aside
      id="session-details-sidebar"
      aria-label="Session details"
      aria-hidden={!isOpen}
      className={
        isOpen
          ? "hidden w-[340px] shrink-0 flex-col border-l border-border bg-background lg:flex xl:w-[360px]"
          : "hidden"
      }
    >
      <SessionRightSidebarContent {...props} />
    </aside>
  );
}
