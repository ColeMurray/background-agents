"use client";

import { useCallback, useMemo } from "react";
import type {
  SessionDiffFile,
  SessionDiffManifest,
  SessionDiffRepository,
} from "@open-inspect/shared";
import type { DiffSelection } from "@/lib/session-diffs";

export interface DiffFileEntry {
  repository: SessionDiffRepository;
  file: SessionDiffFile;
}

/** Flattens a diff manifest into an ordered file list and exposes prev/next navigation. */
export function useDiffFileNavigation({
  manifest,
  selection,
  onSelect,
}: {
  manifest: SessionDiffManifest | null;
  selection: DiffSelection | null;
  onSelect: (selection: DiffSelection) => void;
}): {
  files: DiffFileEntry[];
  selectedIndex: number;
  moveSelection: (offset: number) => void;
} {
  const files = useMemo(
    () =>
      manifest?.repositories.flatMap((repository) =>
        repository.files.map((file) => ({ repository, file }))
      ) ?? [],
    [manifest]
  );
  // Depend on the selection's primitives: callers build the selection object
  // inline per render, which would otherwise defeat this memo.
  const selectedPosition = selection?.repositoryPosition;
  const selectedPath = selection?.path;
  const selectedIndex = useMemo(
    () =>
      selectedPosition === undefined || selectedPath === undefined
        ? -1
        : files.findIndex(
            ({ repository, file }) =>
              repository.position === selectedPosition && file.path === selectedPath
          ),
    [files, selectedPosition, selectedPath]
  );
  const moveSelection = useCallback(
    (offset: number) => {
      const target = files[selectedIndex + offset];
      if (target)
        onSelect({ repositoryPosition: target.repository.position, path: target.file.path });
    },
    [files, selectedIndex, onSelect]
  );
  return { files, selectedIndex, moveSelection };
}
