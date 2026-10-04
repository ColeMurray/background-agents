"use client";

import { useState } from "react";
import { useSlackChannels } from "@/hooks/use-slack-channels";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Combobox } from "@/components/ui/combobox";
import { ChevronDownIcon } from "@/components/ui/icons";
import type { BindingEditor, BindingEditorParams } from "./binding-editor";

export function useSlackBindingEditor({
  id,
  disabled,
  pending,
  teamId,
  canManageBindings,
  discoveryActive,
}: BindingEditorParams & {
  pending: boolean;
  teamId: string;
  canManageBindings: boolean;
  /** Keep discovery admission active while Slack is selected or Slack bindings are displayed. */
  discoveryActive: boolean;
}): BindingEditor {
  const [channelId, setChannelId] = useState("");
  const [manualEntry, setManualEntry] = useState(false);
  const {
    channels,
    error: channelsError,
    accessDenied,
    loading: channelsLoading,
    mutate: reloadChannels,
  } = useSlackChannels(canManageBindings && discoveryActive, teamId);
  const locked = accessDenied;
  const fieldDisabled = disabled || locked;
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
  const pickerDisabled =
    fieldDisabled || channelsLoading || !!channelsError || !channelOptions.length;
  const externalId = channelId.trim();
  const canSubmit =
    !fieldDisabled && (manualEntry ? externalId.length > 0 : !pickerDisabled && !!selectedChannel);
  const displayName = (externalId: string) => channelNames.get(externalId) ?? externalId;

  return {
    providerLabel: "Slack",
    bindLabel: "Bind channel",
    locked,
    externalId,
    canSubmit,
    clearDraft: () => setChannelId(""),
    reset: () => {
      setChannelId("");
      setManualEntry(false);
    },
    field: (
      <>
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
            disabled={fieldDisabled}
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
      </>
    ),
    footer: (
      <>
        <p className="text-xs text-muted-foreground">
          Only channels the Slack bot has joined are listed. Invite it to a channel to add it here;
          externally shared channels cannot be bound. Select a bound channel to change its kind.
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={fieldDisabled}
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
      </>
    ),
    displayName,
    unbindLabel: (externalId) => `Unbind Slack channel ${displayName(externalId)}`,
  };
}
