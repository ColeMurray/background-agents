"use client";

import Link from "next/link";
import {
  childStatusToolEnvelopeSchema,
  type ChildStatusToolEnvelope,
} from "@open-inspect/shared/child-status-tool";
import type { SandboxEvent } from "@/types/session";
import { Badge } from "./ui/badge";
import { SafeMarkdown } from "./safe-markdown";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
type ChildSession = Extract<ChildStatusToolEnvelope, { kind: "detail" }>["session"];

function ChildSummary({ session }: { session: ChildSession }) {
  const fields = [
    [
      "Repository",
      session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : null,
    ],
    ["Branch", session.branchName],
    ["Model", session.model],
  ];
  return (
    <div className="min-w-0 space-y-2 border border-border-muted bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/session/${encodeURIComponent(session.id)}`}
            className="break-words text-sm font-medium text-accent hover:underline [overflow-wrap:anywhere]"
          >
            {session.title || session.id}
          </Link>
          <p className="break-all font-mono text-xs text-muted-foreground">{session.id}</p>
        </div>
        <Badge
          variant={
            session.status === "failed" || session.status === "cancelled"
              ? "pr-closed"
              : session.status === "completed"
                ? "pr-merged"
                : "default"
          }
          className="shrink-0"
        >
          {session.status}
        </Badge>
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {fields.map(([label, value]) =>
          value ? (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-words [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ) : null
        )}
      </dl>
    </div>
  );
}

function ChildStatusDetails({
  result,
  includeResponse,
}: {
  result: ChildStatusToolEnvelope;
  includeResponse: boolean;
}) {
  return (
    <div className="min-w-0 space-y-3 text-sm">
      {result.kind === "list" ? (
        <>
          <h3 className="font-medium">Child sessions ({result.children.length})</h3>
          {result.children.length === 0 ? (
            <p className="text-muted-foreground">No child sessions found.</p>
          ) : (
            <div className="max-h-96 space-y-2 overflow-auto">
              {result.children.map((child) => (
                <ChildSummary key={child.id} session={child} />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <ChildSummary session={result.session} />
          {result.finalResponse ? (
            <section
              aria-label={
                result.hasUnfinishedPrompt ? "Latest completed response" : "Final response"
              }
              className="max-h-96 overflow-auto border border-border-muted bg-card p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="font-medium">
                  {result.hasUnfinishedPrompt ? "Latest completed response" : "Final response"}
                </h3>
                <Badge variant={result.finalResponse.success ? "pr-merged" : "pr-closed"}>
                  {result.finalResponse.success ? "Response succeeded" : "Response failed"}
                </Badge>
              </div>
              {result.hasUnfinishedPrompt && (
                <p className="mb-2 text-xs text-muted-foreground">
                  A newer prompt is queued or running.
                </p>
              )}
              {result.finalResponse.eventLimitReached && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {result.finalResponse.eventCount ?? "Maximum"} events (limit reached)
                </p>
              )}
              {result.finalResponse.error && (
                <p className="mb-2 break-words text-destructive">{result.finalResponse.error}</p>
              )}
              <SafeMarkdown
                content={result.finalResponse.textContent || "(empty)"}
                linkMode="externalOnly"
              />
            </section>
          ) : includeResponse ? (
            <p className="text-muted-foreground">Final response is not available yet.</p>
          ) : null}
        </>
      )}
      <details className="min-w-0 border border-border-muted bg-card p-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Full tool output</summary>
        <pre className="mt-2 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {result.kind === "detail" && result.finalResponse
            ? `${result.agentMessage}\n\nfinalResponse.textContent:\n${result.finalResponse.textContent}`
            : result.agentMessage}
        </pre>
      </details>
    </div>
  );
}

export function renderChildStatusDetails(event: ToolCallEvent) {
  if (!event.output) return null;
  try {
    const result = childStatusToolEnvelopeSchema.safeParse(JSON.parse(event.output));
    return result.success ? (
      <ChildStatusDetails
        result={result.data}
        includeResponse={event.args?.includeResponse === true}
      />
    ) : null;
  } catch {
    return null;
  }
}
