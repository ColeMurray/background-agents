"use client";

import { useId, useState } from "react";
import useSWR from "swr";
import {
  teamChannelBindingsResponseSchema,
  type TeamChannelBindingKind,
} from "@open-inspect/shared/types/team-channel-bindings";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import { useSlackChannels } from "@/hooks/use-slack-channels";
import type { TeamResponse } from "@/hooks/use-teams";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Combobox } from "@/components/ui/combobox";
import { ChevronDownIcon } from "@/components/ui/icons";

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
  const [manualEntry, setManualEntry] = useState(false);
  const [kind, setKind] = useState<TeamChannelBindingKind>("source");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const {
    channels,
    error: channelsError,
    accessDenied: channelsAccessDenied,
    loading: channelsLoading,
    mutate: reloadChannels,
  } = useSlackChannels(canManageBindings, team.id);
  const disabled =
    !canManageBindings || !session?.user || pending || isLoading || !!error || channelsAccessDenied;
  const channelNames = new Map(channels.map((channel) => [channel.id, `#${channel.name}`]));
  const channelOptions = channels
    .filter((channel) => channel.isMember)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((channel) => ({
      value: channel.id,
      label: `#${channel.name}`,
      description: channel.isPrivate ? "Private channel" : undefined,
    }));
  const selectedChannel = channelOptions.find((channel) => channel.value === channelId);
  const pickerDisabled = disabled || channelsLoading || !!channelsError || !channelOptions.length;
  const bindDisabled =
    disabled || (manualEntry ? !channelId.trim() : pickerDisabled || !selectedChannel);

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
          if (!bindDisabled) void changeBinding(channelId.trim(), "PUT");
        }}
      >
        <fieldset
          disabled={disabled}
          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <label
              id={`${id}-channel-label`}
              htmlFor={`${id}-channel`}
              className="block text-sm font-medium"
            >
              {manualEntry ? "Slack channel ID" : "Slack channel"}
            </label>
            {manualEntry ? (
              <input
                id={`${id}-channel`}
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
                placeholder="C0123456789"
                autoComplete="off"
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
              />
            ) : (
              <Combobox
                id={`${id}-channel`}
                labelId={`${id}-channel-label`}
                value={channelId}
                onChange={setChannelId}
                items={channelOptions}
                searchable
                searchPlaceholder="Search channels..."
                dropdownWidth="w-full"
                maxDisplayed={100}
                disabled={pickerDisabled}
                triggerClassName="flex w-full items-center justify-between gap-2 rounded border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
              >
                <span className="truncate">
                  {selectedChannel?.label ??
                    (channelsLoading ? "Loading channels..." : "Select a channel")}
                </span>
                <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Combobox>
            )}
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
          <Button type="submit" disabled={bindDisabled}>
            {pending ? "Updating..." : "Bind channel"}
          </Button>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Only channels the Slack bot has joined are listed. Invite it to a channel to add it here;
          externally shared channels cannot be bound. Select a bound channel to change its kind.
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            setManualEntry(!manualEntry);
            setChannelId("");
          }}
        >
          {manualEntry ? "Choose from channels" : "Enter a channel ID instead"}
        </Button>
        {canManageBindings &&
          (channelsError ? (
            <ErrorBanner role="alert">
              Unable to load Slack channels.{" "}
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={pending || channelsLoading}
                onClick={() => void reloadChannels().catch(() => undefined)}
              >
                Retry channels
              </Button>
            </ErrorBanner>
          ) : !channelsLoading && channelOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No available channels. Invite the Slack bot to a channel, then{" "}
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => void reloadChannels().catch(() => undefined)}
              >
                Refresh channels
              </Button>
              .
            </p>
          ) : null)}
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
                    <p className="break-all text-sm text-foreground">
                      {binding.provider === "slack"
                        ? (channelNames.get(binding.externalId) ?? binding.externalId)
                        : binding.externalId}
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
                      aria-label={`Unbind Slack channel ${channelNames.get(binding.externalId) ?? binding.externalId}`}
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
