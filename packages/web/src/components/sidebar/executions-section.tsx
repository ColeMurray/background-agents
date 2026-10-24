"use client";

import { useState } from "react";
import type { SessionCapabilities } from "@/lib/session-capabilities";
import { useSessionExecutions } from "@/hooks/use-session-executions";
import { Button } from "@/components/ui/button";

export function ExecutionsSection({
  sessionId,
  capabilities,
}: {
  sessionId: string;
  capabilities: SessionCapabilities;
}) {
  const { commands, error, isLoading, cancel, output } = useSessionExecutions(sessionId, true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [outputText, setOutputText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading)
    return <p className="text-xs text-muted-foreground">Loading isolated executions…</p>;
  if (error)
    return (
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
    );
  if (commands.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Run, build, and test tools create a fresh isolated sandbox with no repository checkout or
        model credentials. No executions have been created.
      </p>
    );
  }

  return (
    <section aria-label="Isolated executions" className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Each command runs in a dedicated isolated sandbox, separate from the agent workspace.
      </p>
      {actionError && (
        <p role="alert" className="text-xs text-destructive">
          {actionError}
        </p>
      )}
      <ul className="space-y-2">
        {commands.map((command) => {
          const active = ["queued", "dispatched", "running", "cancelling"].includes(command.state);
          return (
            <li key={command.id} className="rounded-md border border-border p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium capitalize">{command.purpose}</div>
                  <div className="font-mono text-muted-foreground">{command.state}</div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      if (expanded === command.id) {
                        setExpanded(null);
                        return;
                      }
                      setPending(command.id);
                      setActionError(null);
                      try {
                        const page = await output(command.id);
                        setOutputText(page.chunks.map((chunk) => chunk.data).join(""));
                        setExpanded(command.id);
                      } catch (cause) {
                        setActionError(
                          cause instanceof Error ? cause.message : "Output unavailable"
                        );
                      } finally {
                        setPending(null);
                      }
                    }}
                    disabled={pending === command.id}
                  >
                    {expanded === command.id ? "Hide output" : "View output"}
                  </Button>
                  {active && capabilities.collaborate && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        setActionError(null);
                        void cancel(command.id).catch((cause) =>
                          setActionError(
                            cause instanceof Error ? cause.message : "Cancellation failed"
                          )
                        );
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
              {command.error && <p className="mt-2 text-destructive">{command.error}</p>}
              {expanded === command.id && (
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-[11px]">
                  {outputText || "No output."}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
