"use client";

import { useState } from "react";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { formatSessionCost } from "@/lib/session-cost";
import { PropertyRow } from "./details-section";

interface BudgetSectionProps {
  sessionId: string;
  totalCost: number;
  maxSessionCostUsd?: number | null;
  canManageBudget: boolean;
}

/** The session's cost row; render it inside a `PropertyList`. */
export function BudgetSection({
  sessionId,
  totalCost,
  maxSessionCostUsd,
  canManageBudget,
}: BudgetSectionProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManageBudget && maxSessionCostUsd == null && totalCost <= 0) {
    return null;
  }

  const updateLimit = async (maxCostUsd: number | null) => {
    setSaving(true);
    setError(null);
    try {
      const response = await browserApiFetch(`/api/sessions/${sessionId}/budget`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxCostUsd }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const serverMessage =
          body &&
          typeof body === "object" &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : null;
        throw new Error(serverMessage ?? "Unable to update the session cost limit");
      }
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update the session cost limit");
    } finally {
      setSaving(false);
    }
  };

  const saveValue = () => {
    const limit = Number(value);
    if (!Number.isFinite(limit) || limit <= 0) {
      setError("Enter a positive USD amount");
      return;
    }
    void updateLimit(limit);
  };

  const summary =
    maxSessionCostUsd != null
      ? `${formatSessionCost(totalCost)} of ${formatSessionCost(maxSessionCostUsd)} limit`
      : totalCost > 0
        ? formatSessionCost(totalCost)
        : "No limit set";

  return (
    <PropertyRow label="Cost">
      <span className="flex items-baseline justify-between gap-2">
        <span>{summary}</span>
        {canManageBudget && !editing && (
          <button
            type="button"
            className="shrink-0 text-accent hover:underline"
            onClick={() => {
              setValue(maxSessionCostUsd?.toString() ?? "");
              setEditing(true);
            }}
          >
            Edit limit
          </button>
        )}
      </span>

      {editing && (
        <div className="mt-2 space-y-2 border-l-2 border-border pl-3">
          <label className="block text-muted-foreground" htmlFor="session-cost-limit">
            USD limit for this session
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="session-cost-limit"
              type="number"
              min="0.01"
              step="0.01"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="min-w-0 flex-1 border border-border bg-input px-2 py-1 text-foreground"
              disabled={saving}
            />
            <button type="button" className="text-accent" onClick={saveValue} disabled={saving}>
              Save
            </button>
            <button
              type="button"
              className="text-muted-foreground"
              onClick={() => void updateLimit(null)}
              disabled={saving}
            >
              No limit
            </button>
          </div>
          <p className="text-muted-foreground">Applies only to this session.</p>
        </div>
      )}

      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Costs and limits reflect reported model usage only.
      </p>
      {error && (
        <p role="alert" className="mt-1 text-destructive">
          {error}
        </p>
      )}
    </PropertyRow>
  );
}
