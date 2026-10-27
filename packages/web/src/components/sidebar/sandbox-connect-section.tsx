"use client";

import { TerminalIcon } from "@/components/ui/icons";

/**
 * Shown when the control plane will hand out the sandbox's terminal, editor and desktop
 * credentials only on an explicit connect, because opening them would turn off the session
 * owner's personal memory search for the rest of the session.
 */
export function SandboxConnectSection({
  onConnect,
  pending = false,
  failed = false,
}: {
  onConnect: () => void;
  pending?: boolean;
  /** The last attempt failed; the button retries it. */
  failed?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-sm">
        <TerminalIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={onConnect}
          disabled={pending}
          className="text-accent hover:underline disabled:text-muted-foreground disabled:no-underline"
        >
          {pending ? "Opening terminal, editor and desktop…" : "Open terminal, editor and desktop"}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Opening these tools in someone else&apos;s session stops the agent from searching their
        personal memories for the rest of the session.
      </p>
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          Couldn&apos;t open the sandbox tools. Try again.
        </p>
      )}
    </div>
  );
}
