import {
  SessionRightSidebarContent,
  type SessionRightSidebarContentProps,
} from "./session-right-sidebar";

interface SessionDetailsOverlayProps extends SessionRightSidebarContentProps {
  isOpen: boolean;
  isPhone: boolean;
  sheetDragY: number;
  onClose: () => void;
  onSheetTouchStart: React.TouchEventHandler<HTMLDivElement>;
  onSheetTouchMove: React.TouchEventHandler<HTMLDivElement>;
  onSheetTouchEnd: React.TouchEventHandler<HTMLDivElement>;
}

export function SessionDetailsOverlay({
  isOpen,
  isPhone,
  sheetDragY,
  onClose,
  onSheetTouchStart,
  onSheetTouchMove,
  onSheetTouchEnd,
  sessionId,
  sessionState,
  participants,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
}: SessionDetailsOverlayProps) {
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
    />
  );

  return (
    <div className={`fixed inset-0 z-50 lg:hidden ${isOpen ? "" : "pointer-events-none"}`}>
      <div
        className={`absolute inset-0 bg-overlay transition-opacity duration-200 ${
          isOpen ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />

      {isPhone ? (
        <div
          id="session-details-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Session details"
          className="absolute inset-x-0 bottom-0 max-h-[85vh] bg-background border-t border-border-muted shadow-xl flex flex-col"
          style={{
            transform: isOpen ? `translateY(${sheetDragY}px)` : "translateY(100%)",
            transition: sheetDragY > 0 ? "none" : "transform 200ms ease-in-out",
          }}
        >
          <div
            className="px-4 pt-3 pb-2 border-b border-border-muted"
            onTouchStart={onSheetTouchStart}
            onTouchMove={onSheetTouchMove}
            onTouchEnd={onSheetTouchEnd}
            onTouchCancel={onSheetTouchEnd}
          >
            <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-muted" />
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-foreground">Session details</h2>
              <button
                type="button"
                onClick={onClose}
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
          id="session-details-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Session details"
          className="absolute inset-y-0 right-0 w-80 max-w-[85vw] bg-background border-l border-border-muted shadow-xl flex flex-col transition-transform duration-200 ease-in-out"
          style={{ transform: isOpen ? "translateX(0)" : "translateX(100%)" }}
        >
          <div className="px-4 py-3 border-b border-border-muted flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">Session details</h2>
            <button
              type="button"
              onClick={onClose}
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
