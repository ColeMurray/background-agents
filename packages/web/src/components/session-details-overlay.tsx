"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type TouchEvent,
} from "react";
import {
  SessionRightSidebarContent,
  type SessionRightSidebarContentProps,
} from "./session-right-sidebar";

interface SessionDetailsOverlayProps extends SessionRightSidebarContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPhone: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function SessionDetailsOverlay({
  open,
  onOpenChange,
  isPhone,
  returnFocusRef,
  sessionId,
  sessionState,
  participants,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
  diffState,
  diffLoading,
  diffError,
  selectedDiff,
  onOpenDiff,
}: SessionDetailsOverlayProps) {
  const [sheetDragY, setSheetDragY] = useState(0);
  const sheetDragYRef = useRef(0);
  const sheetTouchStartYRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const resetSheetDragState = useCallback(() => {
    setSheetDragY(0);
    sheetDragYRef.current = 0;
  }, []);

  const closeOverlay = useCallback(() => {
    onOpenChange(false);
    resetSheetDragState();
    returnFocusRef?.current?.focus();
  }, [onOpenChange, resetSheetDragState, returnFocusRef]);

  const handleSheetTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const startY = event.touches[0]?.clientY;
    sheetTouchStartYRef.current = startY ?? null;
  }, []);

  const handleSheetTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const startY = sheetTouchStartYRef.current;
    const currentY = event.touches[0]?.clientY;

    if (startY === null || currentY === undefined) return;

    const delta = currentY - startY;
    if (delta > 0) {
      const nextDragY = Math.min(delta, 180);
      sheetDragYRef.current = nextDragY;
      setSheetDragY(nextDragY);
    } else {
      sheetDragYRef.current = 0;
      setSheetDragY(0);
    }
  }, []);

  const handleSheetTouchEnd = useCallback(() => {
    if (sheetDragYRef.current > 100) {
      closeOverlay();
      sheetTouchStartYRef.current = null;
      return;
    }

    resetSheetDragState();
    sheetTouchStartYRef.current = null;
  }, [closeOverlay, resetSheetDragState]);

  const handleDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusableElements = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((element) => element.offsetParent !== null || element === document.activeElement);

    if (focusableElements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }, []);

  useEffect(() => {
    if (open) return;
    resetSheetDragState();
  }, [open, resetSheetDragState]);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeOverlay();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeOverlay, open]);

  useEffect(() => {
    if (!open) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [open]);

  const sidebarContent = (
    <SessionRightSidebarContent
      sessionId={sessionId}
      sessionState={sessionState}
      participants={participants}
      events={events}
      artifacts={artifacts}
      terminalOpen={terminalOpen}
      onToggleTerminal={onToggleTerminal}
      onOpenMedia={onOpenMedia}
      diffState={diffState}
      diffLoading={diffLoading}
      diffError={diffError}
      selectedDiff={selectedDiff}
      onOpenDiff={onOpenDiff}
    />
  );

  return (
    <div className={`fixed inset-0 z-50 lg:hidden ${open ? "" : "pointer-events-none"}`}>
      <div
        className={`absolute inset-0 bg-overlay transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={closeOverlay}
      />

      {isPhone ? (
        <div
          ref={dialogRef}
          id="session-details-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Session details"
          tabIndex={-1}
          className="absolute inset-x-0 bottom-0 max-h-[85vh] bg-background border-t border-border-muted shadow-xl flex flex-col"
          onKeyDown={handleDialogKeyDown}
          style={{
            transform: open ? `translateY(${sheetDragY}px)` : "translateY(100%)",
            transition: sheetDragY > 0 ? "none" : "transform 200ms ease-in-out",
          }}
        >
          <div
            className="px-4 pt-3 pb-2 border-b border-border-muted"
            onTouchStart={handleSheetTouchStart}
            onTouchMove={handleSheetTouchMove}
            onTouchEnd={handleSheetTouchEnd}
            onTouchCancel={handleSheetTouchEnd}
          >
            <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-muted" />
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-foreground">Session details</h2>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeOverlay}
                className="text-sm text-muted-foreground hover:text-foreground transition"
              >
                Close
              </button>
            </div>
          </div>
          <div className="overflow-y-auto">{sidebarContent}</div>
        </div>
      ) : (
        <div
          ref={dialogRef}
          id="session-details-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Session details"
          tabIndex={-1}
          className="absolute inset-y-0 right-0 w-80 max-w-[85vw] bg-background border-l border-border-muted shadow-xl flex flex-col transition-transform duration-200 ease-in-out"
          onKeyDown={handleDialogKeyDown}
          style={{ transform: open ? "translateX(0)" : "translateX(100%)" }}
        >
          <div className="px-4 py-3 border-b border-border-muted flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">Session details</h2>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeOverlay}
              className="text-sm text-muted-foreground hover:text-foreground transition"
            >
              Close
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">{sidebarContent}</div>
        </div>
      )}
    </div>
  );
}
