"use client";

import { useCallback, useRef, useState } from "react";
import type { DiffSelection } from "@/lib/session-diffs";

/** Rendered, and not inside an inert container such as the closed mobile details sheet. */
function canTakeFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(
    element?.isConnected && element.offsetParent !== null && !element.closest("[inert]")
  );
}

function findDiffRow(selection: DiffSelection): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-diff-path]")).find(
    (row) =>
      row.dataset.diffRepositoryPosition === String(selection.repositoryPosition) &&
      row.dataset.diffPath === selection.path &&
      canTakeFocus(row)
  );
}

interface UseSessionDiffSelectionOptions {
  /** Runs when a diff opens, but not when the viewer moves between files inside it. */
  onOpen: () => void;
  /** Takes focus when neither the current file's row nor the diff's opener can. */
  focusFallback: () => void;
}

/**
 * The file shown in the diff view. Closing it returns focus to the current
 * file's row in the details sidebar, else to whatever opened the diff, else to
 * `focusFallback`.
 */
export function useSessionDiffSelection({ onOpen, focusFallback }: UseSessionDiffSelectionOptions) {
  const [selectedDiff, setSelectedDiff] = useState<DiffSelection | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const openDiff = useCallback(
    (selection: DiffSelection) => {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelectedDiff(selection);
      onOpen();
    },
    [onOpen]
  );

  const closeDiff = useCallback(() => {
    const current = selectedDiff;
    const opener = openerRef.current;
    setSelectedDiff(null);
    // Choose a target once the session layout is back on screen.
    requestAnimationFrame(() => {
      const target = (current && findDiffRow(current)) || (canTakeFocus(opener) ? opener : null);
      if (target) target.focus();
      else focusFallback();
    });
  }, [focusFallback, selectedDiff]);

  return { selectedDiff, openDiff, selectDiff: setSelectedDiff, closeDiff };
}
