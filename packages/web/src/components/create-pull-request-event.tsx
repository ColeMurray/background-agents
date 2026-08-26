"use client";

import { useState } from "react";
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

type PullRequestResult =
  | {
      kind: "created" | "updated";
      number: number;
      url: string;
      head?: string;
      base?: string;
      state: "open" | "draft";
    }
  | { kind: "manual"; url: string }
  | { kind: "failure"; message: string }
  | { kind: "pending" }
  | { kind: "unknown"; output: string };

const FAILURE_PREFIX =
  /^(Failed to create pull request|Authentication failed|Session not found|Conflict):/;
const PR_LINE = /PR #(\d+)(?: \((.+?) -> (.+?)\))?: (\S+)/;
const MANUAL_URL = /Create the pull request in GitHub:\s*\n(\S+)/;

function parseResult(event: ToolCallEvent): PullRequestResult {
  const output = event.output?.trim();
  if (!output) {
    return event.status === "error"
      ? { kind: "failure", message: "Pull request creation failed." }
      : { kind: "pending" };
  }

  if (FAILURE_PREFIX.test(output)) return { kind: "failure", message: output };

  const manualMatch = output.match(MANUAL_URL);
  if (manualMatch) return { kind: "manual", url: manualMatch[1] };

  const prMatch = output.match(PR_LINE);
  if (prMatch) {
    return {
      kind: output.startsWith("Pull request updated") ? "updated" : "created",
      number: Number(prMatch[1]),
      url: prMatch[4],
      head: prMatch[2],
      base: prMatch[3],
      state: output.includes("in draft mode") ? "draft" : "open",
    };
  }

  return event.status === "error"
    ? { kind: "failure", message: output }
    : { kind: "unknown", output };
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

function PullRequestLink({ href, manual = false }: { href: string; manual?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1.5 bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-80"
    >
      {manual ? "Create PR" : "Open PR"}
      <LinkIcon className="h-3 w-3" />
    </a>
  );
}

function summaryForResult(result: PullRequestResult): string {
  switch (result.kind) {
    case "created":
      return `Opened pull request #${result.number}`;
    case "updated":
      return `Updated pull request #${result.number}`;
    case "manual":
      return "Branch pushed for pull request";
    case "failure":
      return "Create pull request failed";
    case "unknown":
      return "Create pull request completed";
    case "pending":
      return "Creating pull request";
  }
}

function statusForResult(result: Exclude<PullRequestResult, { kind: "failure" }>): string {
  switch (result.kind) {
    case "created":
      return result.state === "draft" ? "Draft" : "Open";
    case "updated":
      return "Updated";
    case "manual":
      return "Branch pushed";
    case "unknown":
      return "Completed";
    case "pending":
      return "Creating";
  }
}

function footerForResult(result: Exclude<PullRequestResult, { kind: "failure" }>): string {
  switch (result.kind) {
    case "created":
      return result.state === "draft" ? "Draft pull request" : "Ready for review";
    case "updated":
      return "Latest commits pushed";
    case "manual":
      return "Branch ready";
    case "unknown":
      return "Result details below";
    case "pending":
      return "Creating pull request...";
  }
}

function PullRequestCard({ event, result }: { event: ToolCallEvent; result: PullRequestResult }) {
  const title = getStringArg(event, "title") ?? "Pull request";
  const rawBody = event.args?.body;
  const body = typeof rawBody === "string" && rawBody.trim() ? rawBody : undefined;

  if (result.kind === "failure") {
    return (
      <div className="border border-destructive-border bg-destructive-muted p-4 text-xs">
        <div className="flex items-start gap-2 text-destructive">
          <ErrorIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Couldn&apos;t create pull request</div>
            <div className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">
              {result.message}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const pullRequest = result.kind === "created" || result.kind === "updated" ? result : null;
  const resultUrl = pullRequest?.url ?? (result.kind === "manual" ? result.url : null);
  const safeUrl = getSafeExternalUrl(resultUrl);
  const repository = getStringArg(event, "repo") ?? repositoryFromUrl(safeUrl);
  const status = statusForResult(result);
  const mutedStatus = result.kind === "pending" || result.kind === "unknown" || status === "Draft";

  return (
    <div className="overflow-hidden border border-border bg-card">
      <div className="bg-muted/40 p-4">
        <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <GitPrIcon className="h-4 w-4 shrink-0 text-foreground" />
            <span className="truncate">{repository ?? "Pull request"}</span>
          </span>
          <span
            className={cn(
              "shrink-0 border px-2 py-0.5 font-medium",
              mutedStatus
                ? "border-border bg-muted text-muted-foreground"
                : "border-success/30 bg-success-muted text-success"
            )}
          >
            {status}
          </span>
        </div>
        <div className="font-semibold leading-snug text-foreground">
          {title}
          {pullRequest && (
            <span className="font-normal text-muted-foreground"> #{pullRequest.number}</span>
          )}
        </div>
        {pullRequest?.head && pullRequest.base && (
          <div className="mt-3">
            <BranchRoute head={pullRequest.head} base={pullRequest.base} />
          </div>
        )}
      </div>

      {body && <PullRequestBody body={body} />}

      <div className="flex items-center justify-between gap-3 border-t border-border-muted p-3">
        <span className="text-[11px] text-muted-foreground">{footerForResult(result)}</span>
        {safeUrl && <PullRequestLink href={safeUrl} manual={result.kind === "manual"} />}
      </div>

      {result.kind === "unknown" && (
        <pre className="max-h-48 overflow-auto border-t border-border-muted p-3 text-xs text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
          {result.output}
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
  const time = formatSessionEventTime(event.timestamp);
  const failed = result.kind === "failure";
  const draft = result.kind === "created" && result.state === "draft";

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
        {failed ? (
          <ErrorIcon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : draft ? (
          <GitPrDraftIcon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <GitPrIcon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground" />
        )}
        <TimelineRowContent time={showTime ? time : undefined}>
          <span
            className={cn(
              (result.kind === "created" || result.kind === "updated") && "text-foreground"
            )}
          >
            {summaryForResult(result)}
          </span>
        </TimelineRowContent>
      </button>

      {isExpanded && (
        <div className="mt-2 min-w-0 w-full max-w-full sm:ml-5 sm:w-[calc(100%_-_1.25rem)]">
          <PullRequestCard event={event} result={result} />
        </div>
      )}
    </div>
  );
}
