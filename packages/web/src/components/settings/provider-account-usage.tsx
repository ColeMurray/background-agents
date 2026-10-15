"use client";

import { useEffect, useState } from "react";
import type { ModelProviderAccount } from "@open-inspect/shared/types/provider-accounts";
import type { ProviderAccountUsage } from "@open-inspect/shared/types/provider-account-usage";
import { useProviderAccountUsage } from "@/hooks/use-provider-account-usage";
import { Button } from "@/components/ui/button";

const UNAVAILABLE_MESSAGES: Record<
  Extract<ProviderAccountUsage, { status: "unavailable" }>["reason"],
  string
> = {
  inactive_account: "Account is disabled or needs reconnection.",
  credentials: "Credentials could not be verified. Check the account connection.",
  timeout: "The usage request timed out. Try again later.",
  provider_error: "The provider could not be reached. Try again later.",
  invalid_response: "The provider returned an unreadable usage response.",
  no_data: "The provider did not report usage limits for this account.",
};

function windowLabel(durationMs: number): string {
  const hours = durationMs / 3_600_000;
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24}-day window`;
  if (hours >= 1 && Number.isInteger(hours)) return `${hours}-hour window`;
  return `${Math.round(durationMs / 60_000)}-minute window`;
}

function UsageSnapshot({
  usage,
}: {
  usage: Extract<ProviderAccountUsage, { status: "available" }>;
}) {
  const [expired, setExpired] = useState(() => usage.expiresAt <= Date.now());
  useEffect(() => {
    if (expired) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, usage.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expired, usage.expiresAt]);
  return (
    <>
      {(!usage.allowed || usage.limitReached) && (
        <p className="text-warning">The provider reports this account is currently limited.</p>
      )}
      {usage.windows.length === 0 && <p>No usage windows reported by the provider.</p>}
      {usage.windows.map((window) => (
        <div key={window.id} className="mt-2">
          <div className="flex flex-wrap justify-between gap-1">
            <span>{windowLabel(window.windowDurationMs)}</span>
            <span>
              {window.usedPercent}% used · {100 - window.usedPercent}% remaining
            </span>
          </div>
          <progress
            aria-label={`${windowLabel(window.windowDurationMs)} usage`}
            className="mt-1 h-1.5 w-full accent-primary"
            max={100}
            value={window.usedPercent}
          />
          <p className="mt-1">
            Resets{" "}
            <time dateTime={new Date(window.resetsAt).toISOString()}>
              {new Date(window.resetsAt).toLocaleString()}
            </time>
            {window.resetsAt <= Date.now() && " (awaiting provider update)"}
          </p>
        </div>
      ))}
      <p className="mt-2">
        Checked{" "}
        <time dateTime={new Date(usage.collectedAt).toISOString()}>
          {new Date(usage.collectedAt).toLocaleTimeString()}
        </time>
        .{" "}
        {expired
          ? "Snapshot expired; refresh for current usage."
          : "Results may be cached for up to a minute."}
      </p>
    </>
  );
}

export function ProviderAccountUsagePanel({ account }: { account: ModelProviderAccount }) {
  const active = account.status === "active" && account.archivedAt === null;
  const supported = account.provider === "openai";
  const { data, error, isMutating, trigger } = useProviderAccountUsage(account.id);
  const usage = isMutating ? undefined : data;
  return (
    <section
      aria-label={`Usage for ${account.displayName}`}
      className="mt-3 rounded-md border border-border-muted p-3 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">Usage limits</span>
        {active && supported && (
          <Button size="xs" variant="subtle" disabled={isMutating} onClick={() => void trigger()}>
            {isMutating ? "Checking usage…" : data || error ? "Refresh usage" : "Check usage"}
          </Button>
        )}
      </div>
      <div className="mt-2 text-muted-foreground" aria-live="polite">
        {!active ? (
          <p>Usage unavailable: account is disabled or needs reconnection.</p>
        ) : !supported || usage?.status === "unsupported" ? (
          <p>Usage reporting is not supported for this provider.</p>
        ) : error ? (
          <p>Usage unavailable. Try again later.</p>
        ) : usage?.status === "unavailable" ? (
          <p>Usage unavailable. {UNAVAILABLE_MESSAGES[usage.reason]}</p>
        ) : usage?.status === "available" ? (
          <UsageSnapshot key={`${usage.collectedAt}:${usage.expiresAt}`} usage={usage} />
        ) : (
          <p>{isMutating ? "Loading usage…" : "Check the remaining allowance for this account."}</p>
        )}
      </div>
    </section>
  );
}
