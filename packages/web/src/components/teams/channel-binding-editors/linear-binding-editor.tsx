"use client";

import { useState } from "react";
import type { BindingEditor, BindingEditorParams } from "./binding-editor";

export function useLinearBindingEditor({ id, disabled }: BindingEditorParams): BindingEditor {
  const [linearTeamId, setLinearTeamId] = useState("");
  const externalId = linearTeamId.trim();

  return {
    providerLabel: "Linear",
    bindLabel: "Bind team",
    locked: false,
    externalId,
    canSubmit: !disabled && externalId.length > 0,
    clearDraft: () => setLinearTeamId(""),
    reset: () => setLinearTeamId(""),
    field: (
      <>
        <label
          id={`${id}-channel-label`}
          htmlFor={`${id}-channel`}
          className="block text-sm font-medium"
        >
          Linear team ID
        </label>
        <input
          id={`${id}-channel`}
          value={linearTeamId}
          onChange={(event) => setLinearTeamId(event.target.value)}
          placeholder="Linear team ID"
          autoComplete="off"
          disabled={disabled}
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
        />
      </>
    ),
    footer: (
      <p className="text-xs text-muted-foreground">
        Enter the Linear team ID, not its name or issue prefix. Enter a bound team&apos;s ID to
        change its kind.
      </p>
    ),
    displayName: (externalId) => externalId,
    unbindLabel: (externalId) => `Unbind Linear team ${externalId}`,
  };
}
