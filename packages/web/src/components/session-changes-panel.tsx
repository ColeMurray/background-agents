"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { mutate } from "swr";
import useSWR from "swr";
import { useEffect, useId, useRef, useState } from "react";
import { formatRepositoryFullName } from "@open-inspect/shared/types/repositories";
import {
  SESSION_DIFF_REVISION_STALE_CODE,
  type SessionDiffErrorCode,
  type SessionDiffFile,
  type SessionDiffState,
} from "@open-inspect/shared/types/session-diffs";
import { useSessionDiffPreferences, type DiffStyle } from "@/hooks/use-session-diff-preferences";
import { sessionDiffKey } from "@/hooks/use-session-diffs";
import { useDiffFileNavigation } from "@/hooks/use-diff-file-navigation";
import { usePanelWidth } from "@/hooks/use-panel-width";
import { parseDiffErrorBody } from "@/lib/session-diffs";
import type { DiffSelection, ResolvedDiffSelection } from "@/lib/session-diffs";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { cn } from "@/lib/utils";
import type { SessionCapabilities } from "@/lib/session-capabilities";
import { DiffRetryNotice } from "@/components/diff-retry-notice";
import { FilesChangedSection } from "@/components/sidebar/files-changed-section";
import { BackIcon, ChevronRightIcon, FileIcon, SidebarIcon } from "@/components/ui/icons";

const PierreDiffRenderer = dynamic(() => import("./pierre-diff-renderer"), {
  ssr: false,
  loading: () => <PanelMessage>Loading diff renderer…</PanelMessage>,
});

const SPLIT_DIFF_MIN_CODE_WIDTH = 640;

type ReadyDiffSelection = Extract<ResolvedDiffSelection, { status: "ready" }>;

class DiffPatchError extends Error {
  constructor(
    message: string,
    readonly code?: SessionDiffErrorCode
  ) {
    super(message);
  }
}

async function fetchPatch(url: BrowserApiPath): Promise<string> {
  const response = await browserApiFetch(url);
  if (!response.ok) {
    let code: SessionDiffErrorCode | undefined;
    try {
      code = parseDiffErrorBody(await response.json()).code;
    } catch {
      // Non-JSON errors still retain their HTTP status.
    }
    throw new DiffPatchError("Failed to load diff patch", code);
  }
  return response.text();
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex min-h-60 flex-col items-center justify-center gap-3 p-8 text-center text-sm leading-relaxed text-muted-foreground"
    >
      <FileIcon className="h-6 w-6 opacity-50" />
      <div className="max-w-xs">{children}</div>
    </div>
  );
}

function fileMessage(file: SessionDiffFile): string {
  if (file.status === "submodule" || file.oldSubmoduleSha || file.newSubmoduleSha) {
    return `Submodule changed (${file.oldSubmoduleSha ?? "—"} → ${file.newSubmoduleSha ?? "—"}).`;
  }
  switch (file.renderState) {
    case "binary":
      return "This binary file changed, but it does not have a text diff.";
    case "too_large":
      return "This patch is too large to display safely.";
    case "metadata_only": {
      const hasModeChange = Boolean(file.oldMode || file.newMode);
      return hasModeChange
        ? `File metadata changed (${file.oldMode ?? "—"} → ${file.newMode ?? "—"}).`
        : "This file changed without renderable text content.";
    }
    default:
      return "This file does not have a renderable patch.";
  }
}

function SelectedFileHeader({
  selected,
  selectedIndex,
  fileCount,
  onMoveSelection,
}: {
  selected: ReadyDiffSelection | null;
  selectedIndex: number;
  fileCount: number;
  onMoveSelection: (offset: number) => void;
}) {
  return (
    <div className="flex min-h-20 items-center gap-3 border-b border-border-muted px-4 py-3">
      <div className="min-w-0 flex-1">
        <p
          className="mb-1 truncate text-[11px] text-muted-foreground"
          title={selected ? formatRepositoryFullName(selected.repository) : undefined}
        >
          {selected ? formatRepositoryFullName(selected.repository) : "Changes"}
        </p>
        <h2
          className="truncate font-mono text-xs font-semibold"
          title={
            selected?.file.oldPath
              ? `${selected.file.oldPath} → ${selected.file.path}`
              : selected?.file.path
          }
        >
          {selected?.file.path ?? "File no longer changed"}
        </h2>
        {selected && (
          <p
            role="group"
            aria-label="File change summary"
            className="mt-1.5 flex gap-2 text-[11px] text-muted-foreground"
          >
            {selected.file.status.replace("_", " ")}
            {selected.file.additions !== null && selected.file.deletions !== null ? (
              <>
                <span className="font-mono text-success">+{selected.file.additions}</span>
                <span className="font-mono text-destructive">-{selected.file.deletions}</span>
              </>
            ) : (
              <span>{selected.file.renderState.replace("_", " ")}</span>
            )}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onMoveSelection(-1)}
          disabled={selectedIndex <= 0}
          aria-label="Previous changed file"
          title="Previous changed file"
          className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <ChevronRightIcon className="h-4 w-4 rotate-180" />
        </button>
        <span
          role="status"
          className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground"
          aria-label="File position"
        >
          {selectedIndex < 0 ? "—" : selectedIndex + 1} / {fileCount}
        </span>
        <button
          type="button"
          onClick={() => onMoveSelection(1)}
          disabled={selectedIndex < 0 || selectedIndex >= fileCount - 1}
          aria-label="Next changed file"
          title="Next changed file"
          className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ChangesPanelToolbar({
  allowSplit,
  activeDiffStyle,
  onDiffStyleChange,
  wrap,
  onWrapChange,
}: {
  allowSplit: boolean;
  activeDiffStyle: DiffStyle;
  onDiffStyleChange: (style: DiffStyle) => void;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-muted px-4 py-2">
      <div role="group" className="inline-flex gap-1" aria-label="Diff layout">
        {(["unified", "split"] as const).map((style) => (
          <button
            key={style}
            type="button"
            aria-pressed={activeDiffStyle === style}
            disabled={style === "split" && !allowSplit}
            title={
              style === "split" && !allowSplit
                ? "Split needs more code space. On desktop, widen the pane or hide the file list."
                : undefined
            }
            onClick={() => onDiffStyleChange(style)}
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40",
              activeDiffStyle === style
                ? "bg-accent-muted text-foreground"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            {style === "unified" ? "Unified" : "Split"}
          </button>
        ))}
      </div>
      <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="accent-accent"
          checked={wrap}
          onChange={(event) => onWrapChange(event.target.checked)}
        />
        Wrap lines
      </label>
    </div>
  );
}

export function SessionChangesPanel({
  sessionId,
  state,
  resolved,
  onClose,
  onSelect,
  mobile = false,
  sidebarShowsFileList = false,
  capabilities,
}: {
  sessionId: string;
  state: SessionDiffState;
  resolved: ResolvedDiffSelection;
  onClose: () => void;
  onSelect: (selection: DiffSelection) => void;
  mobile?: boolean;
  /** The session sidebar already lists the changed files beside this panel. */
  sidebarShowsFileList?: boolean;
  capabilities: SessionCapabilities;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const codeColumnRef = useRef<HTMLDivElement>(null);
  const codeScrollRef = useRef<HTMLDivElement>(null);
  const fileListId = useId();
  // Until the viewer toggles it, the file list opens only when nothing else lists the files.
  const [fileListChoice, setFileListChoice] = useState<boolean | null>(null);
  const isFileListOpen = fileListChoice ?? (!mobile && !sidebarShowsFileList);
  const codeWidth = usePanelWidth(codeColumnRef, { enabled: !mobile });
  const { resolvedTheme } = useTheme();
  const { diffStyle, setDiffStyle, wrap, setWrap } = useSessionDiffPreferences();
  const selected = resolved.status === "ready" ? resolved : null;
  const selection = selected
    ? { repositoryPosition: selected.repository.position, path: selected.file.path }
    : null;
  const { files, selectedIndex, moveSelection } = useDiffFileNavigation({
    manifest: state.current,
    selection,
    onSelect,
  });
  const patchKey =
    selected?.file.renderState === "renderable"
      ? `/api/sessions/${sessionId}/diff/${selected.revisionId}/files/${selected.file.id}`
      : null;
  const {
    data: patch,
    error: patchError,
    isLoading,
  } = useSWR<string>(patchKey, fetchPatch, {
    revalidateOnFocus: false,
  });
  const stale =
    patchError instanceof DiffPatchError && patchError.code === SESSION_DIFF_REVISION_STALE_CODE;
  const allowSplit = !mobile && codeWidth >= SPLIT_DIFF_MIN_CODE_WIDTH;
  const effectiveDiffStyle = allowSplit ? diffStyle : "unified";
  const selectedPath = selected?.file.path;
  const selectedRepositoryPosition = selected?.repository.position;

  useEffect(() => {
    if (codeScrollRef.current) codeScrollRef.current.scrollTop = 0;
  }, [selectedPath, selectedRepositoryPosition]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (stale) void mutate(sessionDiffKey(sessionId));
  }, [sessionId, stale]);

  return (
    <section
      ref={panelRef}
      aria-label="Session changes"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background outline-none"
    >
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to session"
          className="flex items-center gap-1.5 rounded-sm py-2 pr-3 text-xs text-muted-foreground hover:text-foreground"
        >
          <BackIcon className="h-4 w-4" /> Session
        </button>
        <div className="flex min-w-0 items-baseline gap-2 border-l border-border pl-3">
          <span className="text-sm font-semibold">Changes</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setFileListChoice(!isFileListOpen)}
          aria-label={isFileListOpen ? "Hide file list" : "Show file list"}
          aria-controls={fileListId}
          aria-expanded={isFileListOpen}
          className={cn(
            "ml-auto flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
            isFileListOpen
              ? "bg-accent-muted text-foreground"
              : "text-muted-foreground hover:bg-muted"
          )}
        >
          <SidebarIcon className="h-4 w-4" /> File list
        </button>
      </div>

      {state.lastError && (
        <DiffRetryNotice
          sessionId={sessionId}
          message={state.lastError.message}
          variant="banner"
          capabilities={capabilities}
        />
      )}

      <div className={cn("flex min-h-0 flex-1", mobile && "flex-col")}>
        <aside
          id={fileListId}
          aria-label="Changed files"
          hidden={!isFileListOpen}
          className={cn(
            "shrink-0 overflow-auto p-3",
            mobile
              ? "max-h-[40dvh] border-b border-border-muted"
              : "w-56 max-w-[40%] border-r border-border-muted"
          )}
        >
          <FilesChangedSection
            repositories={state.current?.repositories ?? []}
            selected={selection}
            onSelect={(repository, file) => {
              onSelect({ repositoryPosition: repository.position, path: file.path });
              if (mobile) {
                setFileListChoice(false);
                panelRef.current?.focus();
              }
            }}
          />
        </aside>
        <div ref={codeColumnRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SelectedFileHeader
            selected={selected}
            selectedIndex={selectedIndex}
            fileCount={files.length}
            onMoveSelection={moveSelection}
          />
          <ChangesPanelToolbar
            allowSplit={allowSplit}
            activeDiffStyle={effectiveDiffStyle}
            onDiffStyleChange={setDiffStyle}
            wrap={wrap}
            onWrapChange={setWrap}
          />
          <div ref={codeScrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
            {resolved.status === "missing" ? (
              <PanelMessage>This file is no longer part of the latest changes.</PanelMessage>
            ) : resolved.file.renderState !== "renderable" ? (
              <PanelMessage>{fileMessage(resolved.file)}</PanelMessage>
            ) : isLoading ? (
              <PanelMessage>Loading patch…</PanelMessage>
            ) : stale ? (
              <PanelMessage>Refreshing the latest revision…</PanelMessage>
            ) : patchError ? (
              <PanelMessage>Unable to load this patch.</PanelMessage>
            ) : patch ? (
              <PierreDiffRenderer
                patch={patch}
                diffStyle={effectiveDiffStyle}
                wrap={wrap}
                themeType={resolvedTheme === "dark" ? "dark" : "light"}
              />
            ) : (
              <PanelMessage>This patch is empty.</PanelMessage>
            )}
          </div>
          {selected && (
            <details className="shrink-0 border-t border-border-muted px-4 py-2 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">Compared with session start</summary>
              <p
                className="mt-2 break-all font-mono text-[10px]"
                title={`${selected.repository.baseSha} → ${selected.repository.headSha}`}
              >
                {selected.repository.baseSha.slice(0, 12)} →{" "}
                {selected.repository.headSha.slice(0, 12)}
              </p>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
