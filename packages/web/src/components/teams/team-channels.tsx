"use client";

import { useId, useState } from "react";
import useSWR from "swr";
import {
  teamChannelBindingsResponseSchema,
  type TeamChannelBindingKind,
} from "@open-inspect/shared/types/team-channel-bindings";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import type { TeamResponse } from "@/hooks/use-teams";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";

export function TeamChannels({ team }: { team: TeamResponse }) {
  const { canManageBindings } = useTeamCapabilities(team);
  const { data: session } = useAuthSession();
  const id = useId();
  const key = `/api/teams/${encodeURIComponent(team.id)}/channel-bindings` as const;
  const { data, error, isLoading, mutate } = useSWR(
    canManageBindings && session?.user ? [key, session.user.id] : null,
    async () => {
      const response = await browserApiFetch(key);
      if (!response.ok) throw new Error(`Failed to load channel bindings (${response.status})`);
      return teamChannelBindingsResponseSchema.parse(await response.json());
    }
  );
  const [channelId, setChannelId] = useState("");
  const [kind, setKind] = useState<TeamChannelBindingKind>("source");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const disabled = !canManageBindings || !session?.user || pending || isLoading || !!error;

  async function changeBinding(externalId: string, method: "PUT" | "DELETE") {
    if (disabled || !externalId) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await browserApiFetch(`${key}/slack/${encodeURIComponent(externalId)}`, {
        method,
        ...(method === "PUT"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }
          : {}),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message =
          typeof body?.error === "string" ? body.error : "Failed to update channel binding";
        throw new Error(typeof body?.code === "string" ? `${message} (${body.code})` : message);
      }
      if (method === "PUT") setChannelId("");
      await mutate();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Failed to update channel binding");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="text-lg font-semibold text-foreground">
        Channels
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Bind Slack channels to this team. Primary is the team&apos;s home channel; source channels
        also route new sessions to the team.
      </p>
      <form
        className="my-4 space-y-3 rounded-md border border-border-muted p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void changeBinding(channelId.trim(), "PUT");
        }}
      >
        <fieldset
          disabled={disabled}
          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor={`${id}-channel`} className="block text-sm font-medium">
              Slack channel ID
            </label>
            <input
              id={`${id}-channel`}
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
              placeholder="C0123456789"
              autoComplete="off"
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-kind`} className="block text-sm font-medium">
              Binding kind
            </label>
            <select
              id={`${id}-kind`}
              value={kind}
              onChange={(event) => setKind(event.target.value as TeamChannelBindingKind)}
              className="w-full rounded border border-border bg-background px-2 py-2 text-sm disabled:opacity-50"
            >
              <option value="primary">Primary</option>
              <option value="source">Source</option>
            </select>
          </div>
          <Button type="submit" disabled={disabled || !channelId.trim()}>
            {pending ? "Updating..." : "Bind channel"}
          </Button>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Use the channel ID, not its name. Invite the Slack bot first; externally shared channels
          cannot be bound. Enter an existing channel ID to change its binding kind.
        </p>
      </form>
      {!canManageBindings ? (
        <p className="text-sm text-muted-foreground">
          You do not have permission to view or manage channel bindings.
        </p>
      ) : (
        <>
          {failure && (
            <ErrorBanner role="alert" className="mb-4">
              {failure}
            </ErrorBanner>
          )}
          {error ? (
            <ErrorBanner role="alert">
              Unable to load channel bindings.{" "}
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => void mutate().catch(() => undefined)}
              >
                Retry
              </Button>
            </ErrorBanner>
          ) : isLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading channel bindings...
            </p>
          ) : data?.bindings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channel bindings yet.</p>
          ) : (
            <ul
              aria-label="Channel bindings"
              className="divide-y divide-border-muted rounded-md border border-border-muted"
            >
              {data?.bindings.map((binding) => (
                <li
                  key={`${binding.provider}:${binding.externalId}`}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="break-all font-mono text-sm text-foreground">
                      {binding.externalId}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{binding.provider === "slack" ? "Slack" : "Linear"}</span>
                      <Badge>{binding.kind === "primary" ? "Primary" : "Source"}</Badge>
                    </div>
                  </div>
                  {binding.provider === "slack" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      aria-label={`Unbind Slack channel ${binding.externalId}`}
                      onClick={() => void changeBinding(binding.externalId, "DELETE")}
                    >
                      Unbind
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Read-only</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
