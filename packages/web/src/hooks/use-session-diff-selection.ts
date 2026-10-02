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
 * The file shown in the diff view. Closing it returns focus to the control
 * passed to `openDiff`, such as a timeline file link, else to the current file's
 * row in the details sidebar, else to whatever had focus when the diff opened,
 * else to `focusFallback`.
 */
export function useSessionDiffSelection({ onOpen, focusFallback }: UseSessionDiffSelectionOptions) {
  const [selectedDiff, setSelectedDiff] = useState<DiffSelection | null>(null);
  const openerRef = useRef<{ element: HTMLElement | null; explicit: boolean } | null>(null);

  const openDiff = useCallback(
    (selection: DiffSelection, opener?: HTMLElement) => {
      // Safari does not focus a clicked button, so callers that know the control pass it.
      openerRef.current = opener
        ? { element: opener, explicit: true }
        : {
            element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
            explicit: false,
          };
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
      const visibleOpener = canTakeFocus(opener?.element) ? opener.element : null;
      const target =
        (opener?.explicit ? visibleOpener : null) ||
        (current && findDiffRow(current)) ||
        visibleOpener;
      if (target) target.focus();
      else focusFallback();
    });
  }, [focusFallback, selectedDiff]);

  return { selectedDiff, openDiff, selectDiff: setSelectedDiff, closeDiff };
}
