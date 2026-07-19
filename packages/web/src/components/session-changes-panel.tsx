"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { mutate } from "swr";
import useSWR from "swr";
import { useEffect, useRef } from "react";
import { formatRepositoryFullName, SESSION_DIFF_REVISION_STALE_CODE } from "@open-inspect/shared";
import type { SessionDiffErrorCode } from "@open-inspect/shared";
import type { SessionDiffFile, SessionDiffState } from "@open-inspect/shared";
import { useSessionDiffPreferences, type DiffStyle } from "@/hooks/use-session-diff-preferences";
import { sessionDiffKey } from "@/hooks/use-session-diffs";
import { useDiffFileNavigation } from "@/hooks/use-diff-file-navigation";
import { usePanelWidth } from "@/hooks/use-panel-width";
import { parseDiffErrorBody } from "@/lib/session-diffs";
import type { DiffSelection, ResolvedDiffSelection } from "@/lib/session-diffs";
import { cn } from "@/lib/utils";
import { DiffRetryNotice } from "@/components/diff-retry-notice";
import { FilesChangedSection } from "@/components/sidebar/files-changed-section";

const PierreDiffRenderer = dynamic(() => import("./pierre-diff-renderer"), {
  ssr: false,
  loading: () => <PanelMessage>Loading diff renderer…</PanelMessage>,
});

const SPLIT_DIFF_MIN_PANEL_WIDTH = 720;

type ReadyDiffSelection = Extract<ResolvedDiffSelection, { status: "ready" }>;

class DiffPatchError extends Error {
  constructor(
    message: string,
    readonly code?: SessionDiffErrorCode
  ) {
    super(message);
  }
}

async function fetchPatch(url: string): Promise<string> {
  const response = await fetch(url);
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
    <div className="flex min-h-40 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
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

function ChangesPanelHeader({
  selected,
  selectedIndex,
  fileCount,
  onMoveSelection,
  onClose,
}: {
  selected: ReadyDiffSelection | null;
  selectedIndex: number;
  fileCount: number;
  onMoveSelection: (offset: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-14 items-center gap-2 border-b border-border-muted px-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-muted-foreground">
          {selected ? formatRepositoryFullName(selected.repository) : "Changes"}
        </p>
        <h2 className="truncate text-sm font-medium" title={selected?.file.path}>
          {selected?.file.path ?? "File no longer changed"}
        </h2>
        {selected && (
          <p className="truncate text-[11px] text-muted-foreground">
            {selected.file.status.replace("_", " ")}
            {selected.file.additions !== null && selected.file.deletions !== null
              ? ` · +${selected.file.additions} -${selected.file.deletions}`
              : ""}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onMoveSelection(-1)}
        disabled={selectedIndex <= 0}
        aria-label="Previous changed file"
        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => onMoveSelection(1)}
        disabled={selectedIndex < 0 || selectedIndex >= fileCount - 1}
        aria-label="Next changed file"
        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close changes"
        className="rounded p-1.5 text-lg text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

function ChangesPanelToolbar({
  selected,
  availableDiffStyles,
  activeDiffStyle,
  onDiffStyleChange,
  wrap,
  onWrapChange,
}: {
  selected: ReadyDiffSelection | null;
  availableDiffStyles: readonly DiffStyle[];
  activeDiffStyle: DiffStyle;
  onDiffStyleChange: (style: DiffStyle) => void;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-muted px-3 py-2">
      {selected && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Compared with session start</summary>
          <p className="mt-1 font-mono text-[10px]">
            {selected.repository.baseSha.slice(0, 12)} → {selected.repository.headSha.slice(0, 12)}
          </p>
        </details>
      )}
      <div
        role="group"
        className="inline-flex rounded-md border border-border-muted p-0.5"
        aria-label="Diff layout"
      >
        {availableDiffStyles.map((style) => (
          <button
            key={style}
            type="button"
            aria-pressed={activeDiffStyle === style}
            onClick={() => onDiffStyleChange(style)}
            className={cn(
              "rounded px-2 py-1 text-xs capitalize",
              activeDiffStyle === style ? "bg-muted text-foreground" : "text-muted-foreground"
            )}
          >
            {style === "unified" ? "Unified" : "Split"}
          </button>
        ))}
      </div>
      <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
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
}: {
  sessionId: string;
  state: SessionDiffState;
  resolved: ResolvedDiffSelection;
  onClose: () => void;
  onSelect: (selection: DiffSelection) => void;
  mobile?: boolean;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const panelWidth = usePanelWidth(panelRef, { enabled: !mobile });
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
  const allowSplit = !mobile && panelWidth >= SPLIT_DIFF_MIN_PANEL_WIDTH;
  const effectiveDiffStyle = allowSplit ? diffStyle : "unified";
  const availableDiffStyles: readonly DiffStyle[] = allowSplit ? ["unified", "split"] : ["unified"];

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
      className="flex h-full min-w-0 flex-col bg-background outline-none"
    >
      <ChangesPanelHeader
        selected={selected}
        selectedIndex={selectedIndex}
        fileCount={files.length}
        onMoveSelection={moveSelection}
        onClose={onClose}
      />

      <ChangesPanelToolbar
        selected={selected}
        availableDiffStyles={availableDiffStyles}
        activeDiffStyle={effectiveDiffStyle}
        onDiffStyleChange={setDiffStyle}
        wrap={wrap}
        onWrapChange={setWrap}
      />

      {state.lastError && (
        <DiffRetryNotice sessionId={sessionId} message={state.lastError.message} variant="banner" />
      )}

      <div className={cn("flex min-h-0 flex-1", mobile && "flex-col")}>
        <aside
          aria-label="Changed files"
          className={cn(
            "shrink-0 overflow-auto",
            mobile
              ? "max-h-48 border-b border-border-muted p-3"
              : "w-44 border-r border-border-muted p-2"
          )}
        >
          <FilesChangedSection
            repositories={state.current?.repositories ?? []}
            selected={selection}
            onSelect={(repository, file) =>
              onSelect({ repositoryPosition: repository.position, path: file.path })
            }
          />
        </aside>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/20">
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
      </div>
    </section>
  );
}
