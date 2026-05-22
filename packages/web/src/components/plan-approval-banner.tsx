"use client";

import { useEffect, useMemo, useState } from "react";
import type { ModelCategory, PlanApprovalStatus, PlanArtifact } from "@open-inspect/shared";
import { getDefaultReasoningEffort, isValidReasoningEffort } from "@open-inspect/shared";

interface PlanApprovalBannerProps {
  sessionId: string;
  status: PlanApprovalStatus;
  plan: PlanArtifact | null;
  /** Session's currently selected model — pre-fills the impl selector. */
  defaultModel: string;
  /** Session's currently selected reasoning effort (if any). */
  defaultReasoningEffort?: string | null;
  /** Enabled model options grouped by category (same source as the input area selector). */
  modelOptions: ModelCategory[];
  /**
   * Dispatched by the parent (session page) to send the auto-generated impl prompt.
   * Must call `sendPrompt(content, model, reasoningEffort)`.
   */
  onDispatchImplPrompt?: (content: string, model: string, reasoningEffort?: string) => void;
}

export function PlanApprovalBanner({
  sessionId,
  status,
  plan,
  defaultModel,
  defaultReasoningEffort,
  modelOptions,
  onDispatchImplPrompt,
}: PlanApprovalBannerProps) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<string>("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [implModel, setImplModel] = useState<string>(defaultModel);
  const [implReasoningEffort, setImplReasoningEffort] = useState<string | undefined>(
    defaultReasoningEffort ?? undefined
  );

  // Flatten model options for the inline <select>; keep <optgroup> per category
  // so users see the provider grouping that matches the main selector.
  const flatModelGroups = useMemo(
    () =>
      modelOptions.map((group) => ({
        category: group.category,
        models: group.models.map((m) => ({ id: m.id, name: m.name })),
      })),
    [modelOptions]
  );

  // Recompute reasoning effort when the impl model changes, matching the
  // session page's existing behavior (each model has a sensible default).
  useEffect(() => {
    if (!implReasoningEffort || !isValidReasoningEffort(implModel, implReasoningEffort)) {
      setImplReasoningEffort(getDefaultReasoningEffort(implModel));
    }
  }, [implModel, implReasoningEffort]);

  // Keep impl model in sync with session model when the parent updates it
  // (e.g., session loads, user changes model in main selector before approving).
  useEffect(() => {
    setImplModel(defaultModel);
  }, [defaultModel]);

  if (status === "approved") {
    return (
      <div className="mb-3 rounded border border-success-muted bg-success-muted/30 px-3 py-2 text-xs text-success-foreground">
        Plan {plan ? `v${plan.version}` : ""} approved.
      </div>
    );
  }

  if (status === "rejected") {
    // After rejection the session reverts to a normal build flow; the
    // REJECTED badge on the plan bubble in the timeline carries the
    // visual cue, so the banner stays out of the composer area.
    return null;
  }

  // awaiting_approval
  async function approve() {
    setErrorMessage(null);
    setBusy("approve");
    try {
      const res = await fetch(`/api/sessions/${sessionId}/plan/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          implementationModel: implModel,
          implementationReasoningEffort: implReasoningEffort ?? null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(data.error || `Failed to approve plan (HTTP ${res.status})`);
        return;
      }
      // Control-plane persisted impl model on session.model; now dispatch a
      // synthetic prompt to actually start the implementation turn. The
      // dispatched message inherits session.model so the impl runs with the
      // chosen model.
      if (onDispatchImplPrompt && plan) {
        const versionLabel = `v${plan.version}`;
        onDispatchImplPrompt(
          `Implement the approved plan ${versionLabel}. Follow its steps exactly; flag any deviation before applying it.`,
          implModel,
          implReasoningEffort
        );
      }
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setErrorMessage(null);
    setBusy("reject");
    try {
      const res = await fetch(`/api/sessions/${sessionId}/plan/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason || null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(data.error || `Failed to reject plan (HTTP ${res.status})`);
      }
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setRejectOpen(false);
      setRejectReason("");
    }
  }

  function scrollToPlan() {
    if (!plan) return;
    const el = document.getElementById(`plan-${plan.id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="mb-3 rounded border border-border bg-input px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={scrollToPlan}
          disabled={!plan}
          className="text-sm font-medium text-foreground hover:underline disabled:no-underline disabled:cursor-default"
        >
          Plan {plan ? `v${plan.version}` : ""} — awaiting your approval
        </button>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-secondary-foreground">
            <span>Build with</span>
            <select
              value={implModel}
              onChange={(e) => setImplModel(e.target.value)}
              disabled={busy !== null}
              className="rounded border border-border bg-background px-1.5 py-0.5 text-xs disabled:opacity-50"
            >
              {flatModelGroups.map((group) => (
                <optgroup key={group.category} label={group.category}>
                  {group.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={approve}
            disabled={busy !== null}
            className="rounded bg-success px-2 py-1 text-xs font-medium text-success-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setRejectOpen((v) => !v)}
            disabled={busy !== null}
            className="rounded bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
      {rejectOpen && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Optional reason"
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={reject}
            disabled={busy !== null}
            className="rounded bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy === "reject" ? "Rejecting…" : "Confirm reject"}
          </button>
        </div>
      )}
      {errorMessage && <p className="mt-2 text-xs text-destructive">{errorMessage}</p>}
    </div>
  );
}
