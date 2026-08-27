"use client";

import { useState } from "react";
import {
  createPullRequestToolEnvelopeSchema,
  type CreatePullRequestToolEnvelope,
} from "@open-inspect/shared/pull-request-tool";
import type { SandboxEvent } from "@/types/session";
import { formatSessionEventTime } from "@/lib/time";
import { getSafeExternalUrl } from "@/lib/urls";
import {
  BranchIcon,
  ChevronRightIcon,
  ErrorIcon,
  GitPrDraftIcon,
  GitPrIcon,
  LinkIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { SafeMarkdown } from "./safe-markdown";
import { TimelineRowContent } from "./timeline-row-content";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

type LegacyCompletedResult = {
  kind: "created" | "updated";
  prNumber: number;
  prUrl: string;
  state: "open" | "draft";
  headBranch?: string;
  baseBranch?: string;
  agentMessage: string;
};

type PullRequestResult =
  | CreatePullRequestToolEnvelope
  | LegacyCompletedResult
  | { kind: "pending"; output?: string }
  | { kind: "unknown"; output: string };

const FAILURE_PREFIX =
  /^(Failed to create pull request|Authentication failed|Session not found|Conflict):/;
const PR_LINE = /PR #(\d+)(?: \((.+?) -> (.+?)\))?: (\S+)/;
const MANUAL_URL = /Create the pull request in GitHub:\s*\n(\S+)/;

function parseResult(event: ToolCallEvent): PullRequestResult {
  const rawOutput = event.output;
  const output = rawOutput?.trim();
  if (!output) {
    return event.status === "error"
      ? {
          kind: "failure",
          message: "Pull request creation failed.",
          agentMessage: "Pull request creation failed.",
        }
      : { kind: "pending" };
  }

  try {
    const envelope = createPullRequestToolEnvelopeSchema.safeParse(JSON.parse(output));
    if (envelope.success) return envelope.data;
    return unrecognizedResult(event, rawOutput ?? output, output);
  } catch {
    // Persisted events predating the structured envelope contain prose output.
  }

  return parseLegacyResult(event, rawOutput ?? output, output);
}

function parseLegacyResult(
  event: ToolCallEvent,
  rawOutput: string,
  output: string
): PullRequestResult {
  if (FAILURE_PREFIX.test(output)) {
    return { kind: "failure", message: output, agentMessage: output };
  }

  const manualMatch = output.match(MANUAL_URL);
  if (manualMatch) {
    return { kind: "manual", createPrUrl: manualMatch[1], agentMessage: output };
  }

  const prMatch = output.match(PR_LINE);
  if (prMatch) {
    return {
      kind: output.startsWith("Pull request updated") ? "updated" : "created",
      prNumber: Number(prMatch[1]),
      prUrl: prMatch[4],
      headBranch: prMatch[2],
      baseBranch: prMatch[3],
      state: output.includes("in draft mode") ? "draft" : "open",
      agentMessage: output,
    };
  }

  return unrecognizedResult(event, rawOutput, output);
}

function unrecognizedResult(
  event: ToolCallEvent,
  rawOutput: string,
  output: string
): PullRequestResult {
  if (["pending", "running", "in_progress"].includes(event.status ?? "")) {
    return { kind: "pending", output: rawOutput };
  }
  return event.status === "error"
    ? { kind: "failure", message: output, agentMessage: output }
    : { kind: "unknown", output: rawOutput };
}

function getStringArg(event: ToolCallEvent, key: string): string | undefined {
  const value = event.args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function repositoryFromUrl(url: string | null): string | null {
  if (!url) return null;
  const parsed = new URL(url);
  const match = parsed.pathname.match(
    /^\/(.+?)\/(?:pull\/\d+|-\/merge_requests\/\d+|compare\/.+)\/?$/
  );
  if (!match) return parsed.hostname;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function PullRequestBody({ body }: { body: string }) {
  const [showFullBody, setShowFullBody] = useState(false);
  const bodyNeedsClamp = body.length > 240 || body.split("\n").length > 8;

  return (
    <div className="border-t border-border-muted p-4">
      <div className="relative">
        <div className={cn("overflow-hidden", bodyNeedsClamp && !showFullBody && "max-h-40")}>
          <SafeMarkdown
            content={body}
            className="text-xs prose-headings:mb-2 prose-headings:mt-4 prose-headings:text-xs prose-p:text-xs prose-li:text-xs"
          />
        </div>
        {bodyNeedsClamp && !showFullBody && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
      {bodyNeedsClamp && (
        <button
          type="button"
          onClick={() => setShowFullBody((value) => !value)}
          className="mt-2 text-[11px] font-medium text-accent hover:underline"
        >
          {showFullBody ? "Show less" : "Show full description"}
        </button>
      )}
    </div>
  );
}

function BranchRoute({ head, base }: { head: string; base: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
      <BranchIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 font-sans text-secondary-foreground">into</span>
      <span className="shrink-0">{base}</span>
    </div>
  );
}

function PullRequestLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1.5 bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-80"
    >
      {label}
      <LinkIcon className="h-3 w-3" />
    </a>
  );
}

type PresentationTone = "success" | "muted" | "danger";
type PresentationIcon = "pull-request" | "draft" | "error";

interface PullRequestPresentation {
  summary: string;
  status?: string;
  footer?: string;
  tone: PresentationTone;
  icon: PresentationIcon;
  action?: { label: string; url: string };
  prNumber?: number;
  headBranch?: string;
  baseBranch?: string;
  detail?: string;
  rawOutput?: string;
}

function presentationForResult(result: PullRequestResult): PullRequestPresentation {
  switch (result.kind) {
    case "created": {
      const draft = result.state === "draft";
      return {
        summary: `Opened pull request #${result.prNumber}`,
        status: draft ? "Draft" : "Open",
        footer: draft ? "Draft pull request" : "Ready for review",
        tone: draft ? "muted" : "success",
        icon: draft ? "draft" : "pull-request",
        action: { label: "Open PR", url: result.prUrl },
        prNumber: result.prNumber,
        headBranch: result.headBranch,
        baseBranch: result.baseBranch,
      };
    }
    case "updated": {
      const draft = result.state === "draft";
      return {
        summary: `Updated pull request #${result.prNumber}`,
        status: draft ? "Draft" : "Updated",
        footer: "Latest commits pushed",
        tone: draft ? "muted" : "success",
        icon: draft ? "draft" : "pull-request",
        action: { label: "Open PR", url: result.prUrl },
        prNumber: result.prNumber,
        headBranch: result.headBranch,
        baseBranch: result.baseBranch,
      };
    }
    case "manual":
      return {
        summary: "Branch pushed for pull request",
        status: "Branch pushed",
        footer: "Branch ready",
        tone: "success",
        icon: "pull-request",
        action: { label: "Create PR", url: result.createPrUrl },
      };
    case "failure":
      return {
        summary: "Create pull request failed",
        tone: "danger",
        icon: "error",
        detail: result.message,
      };
    case "unknown":
      return {
        summary: "Create pull request completed",
        status: "Completed",
        footer: "Result details below",
        tone: "muted",
        icon: "pull-request",
        rawOutput: result.output,
      };
    case "pending":
      return {
        summary: "Creating pull request",
        status: "Creating",
        footer: result.output ?? "Creating pull request...",
        tone: "muted",
        icon: "pull-request",
      };
  }
}

function PullRequestCard({
  event,
  presentation,
}: {
  event: ToolCallEvent;
  presentation: PullRequestPresentation;
}) {
  const title = getStringArg(event, "title") ?? "Pull request";
  const rawBody = event.args?.body;
  const body = typeof rawBody === "string" && rawBody.trim() ? rawBody : undefined;

  if (presentation.detail) {
    return (
      <div className="border border-destructive-border bg-destructive-muted p-4 text-xs">
        <div className="flex items-start gap-2 text-destructive">
          <ErrorIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Couldn&apos;t create pull request</div>
            <div className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">
              {presentation.detail}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const safeUrl = getSafeExternalUrl(presentation.action?.url);
  const repository = getStringArg(event, "repo") ?? repositoryFromUrl(safeUrl);

  return (
    <div className="overflow-hidden border border-border bg-card">
      <div className="bg-muted/40 p-4">
        <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <GitPrIcon className="h-4 w-4 shrink-0 text-foreground" />
            <span className="truncate">{repository ?? "Pull request"}</span>
          </span>
          {presentation.status && (
            <span
              className={cn(
                "shrink-0 border px-2 py-0.5 font-medium",
                presentation.tone === "success"
                  ? "border-success/30 bg-success-muted text-success"
                  : "border-border bg-muted text-muted-foreground"
              )}
            >
              {presentation.status}
            </span>
          )}
        </div>
        <div className="font-semibold leading-snug text-foreground">
          {title}
          {presentation.prNumber && (
            <span className="font-normal text-muted-foreground"> #{presentation.prNumber}</span>
          )}
        </div>
        {presentation.headBranch && presentation.baseBranch && (
          <div className="mt-3">
            <BranchRoute head={presentation.headBranch} base={presentation.baseBranch} />
          </div>
        )}
      </div>

      {body && <PullRequestBody body={body} />}

      <div className="flex items-center justify-between gap-3 border-t border-border-muted p-3">
        <span className="min-w-0 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {presentation.footer}
        </span>
        {safeUrl && presentation.action && (
          <PullRequestLink href={safeUrl} label={presentation.action.label} />
        )}
      </div>

      {presentation.rawOutput !== undefined && (
        <pre className="max-h-48 overflow-auto border-t border-border-muted p-3 text-xs text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
          {presentation.rawOutput}
        </pre>
      )}
    </div>
  );
}

interface CreatePullRequestEventProps {
  event: ToolCallEvent;
  isExpanded: boolean;
  onToggle: () => void;
  showTime?: boolean;
}

export function CreatePullRequestEvent({
  event,
  isExpanded,
  onToggle,
  showTime = true,
}: CreatePullRequestEventProps) {
  const result = parseResult(event);
  const presentation = presentationForResult(result);
  const time = formatSessionEventTime(event.timestamp);

  return (
    <div className="min-w-0 max-w-full py-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground transition-transform duration-200",
            isExpanded && "rotate-90"
          )}
        />
        {presentation.icon === "error" ? (
          <ErrorIcon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : presentation.icon === "draft" ? (
          <GitPrDraftIcon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <GitPrIcon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground" />
        )}
        <TimelineRowContent time={showTime ? time : undefined}>
          <span className={cn(presentation.tone === "success" && "text-foreground")}>
            {presentation.summary}
          </span>
        </TimelineRowContent>
      </button>

      {isExpanded && (
        <div className="mt-2 min-w-0 w-full max-w-full sm:ml-5 sm:w-[calc(100%_-_1.25rem)]">
          <PullRequestCard event={event} presentation={presentation} />
        </div>
      )}
    </div>
  );
}
