"use client";

import { useId, useState } from "react";
import useSWR from "swr";
import {
  teamChannelBindingsResponseSchema,
  type TeamChannelBindingKind,
  type TeamChannelBindingProvider,
} from "@open-inspect/shared/types/team-channel-bindings";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import type { TeamResponse } from "@/hooks/use-teams";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BindingEditor } from "./channel-binding-editors/binding-editor";
import { useLinearBindingEditor } from "./channel-binding-editors/linear-binding-editor";
import { useSlackBindingEditor } from "./channel-binding-editors/slack-binding-editor";

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
  const [provider, setProvider] = useState<TeamChannelBindingProvider>("slack");
  const [kind, setKind] = useState<TeamChannelBindingKind>("source");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const disabled = !canManageBindings || !session?.user || pending || isLoading || !!error;
  const editors: Record<TeamChannelBindingProvider, BindingEditor> = {
    slack: useSlackBindingEditor({
      id,
      disabled,
      pending,
      teamId: team.id,
      canManageBindings,
      discoveryActive:
        provider === "slack" ||
        data?.bindings.some((binding) => binding.provider === "slack") === true,
    }),
    linear: useLinearBindingEditor({ id, disabled }),
  };
  const editor = editors[provider];
  const providerDisabled = disabled || editor.locked;

  async function changeBinding(
    bindingProvider: TeamChannelBindingProvider,
    externalId: string,
    method: "PUT" | "DELETE"
  ) {
    if (disabled || editors[bindingProvider].locked || !externalId) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await browserApiFetch(
        `${key}/${bindingProvider}/${encodeURIComponent(externalId)}`,
        {
          method,
          ...(method === "PUT"
            ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }
            : {}),
        }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message =
          typeof body?.error === "string" ? body.error : "Failed to update channel binding";
        throw new Error(typeof body?.code === "string" ? `${message} (${body.code})` : message);
      }
      if (method === "PUT") editors[bindingProvider].clearDraft();
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
        Bind Slack channels or Linear teams to this team. Primary marks the team&apos;s main binding
        for each provider; source bindings also route new sessions to the team.
      </p>
      <form
        className="my-4 space-y-3 rounded-md border border-border-muted p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (editor.canSubmit) void changeBinding(provider, editor.externalId, "PUT");
        }}
      >
        <fieldset
          disabled={disabled}
          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="space-y-1">
            <label htmlFor={`${id}-provider`} className="block text-sm font-medium">
              Provider
            </label>
            <Select
              value={provider}
              disabled={disabled}
              onValueChange={(value) => {
                const next = value as TeamChannelBindingProvider;
                editors[next].reset();
                setProvider(next);
                setFailure(null);
              }}
            >
              <SelectTrigger id={`${id}-provider`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(editors).map(([value, { providerLabel }]) => (
                  <SelectItem key={value} value={value}>
                    {providerLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 flex-1 space-y-1">{editor.field}</div>
          <div className="space-y-1">
            <label htmlFor={`${id}-kind`} className="block text-sm font-medium">
              Binding kind
            </label>
            <Select
              value={kind}
              disabled={providerDisabled}
              onValueChange={(value) => setKind(value as TeamChannelBindingKind)}
            >
              <SelectTrigger id={`${id}-kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="primary">Primary</SelectItem>
                <SelectItem value="source">Source</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={!editor.canSubmit}>
            {pending ? "Updating..." : editor.bindLabel}
          </Button>
        </fieldset>
        {editor.footer}
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
                      {editors[binding.provider].displayName(binding.externalId)}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{editors[binding.provider].providerLabel}</span>
                      <Badge>{binding.kind === "primary" ? "Primary" : "Source"}</Badge>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || editors[binding.provider].locked}
                    aria-label={editors[binding.provider].unbindLabel(binding.externalId)}
                    onClick={() =>
                      void changeBinding(binding.provider, binding.externalId, "DELETE")
                    }
                  >
                    Unbind
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
