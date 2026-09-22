"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  sessionProviderAuthStateSchema,
  type ProviderAccountSwitchOperation,
} from "@open-inspect/shared/types/provider-account-switch";
import { subscriptionProviderIdSchema } from "@open-inspect/shared/types/provider-accounts";
import { useProviderAccounts } from "@/hooks/use-provider-accounts";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

async function requestState(path: BrowserApiPath, body?: unknown) {
  const response = await browserApiFetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
  );
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? "Account state changed or this runtime cannot switch. Refresh and retry."
        : "Provider account request failed"
    );
  return sessionProviderAuthStateSchema.parse(await response.json());
}
export function SessionProviderAccount({
  sessionId,
  model,
  canSwitch,
  recovery,
}: {
  sessionId: string;
  model: string;
  canSwitch: boolean;
  recovery?: ProviderAccountSwitchOperation | null;
}) {
  const { hasPermission } = useCurrentUserAuthorization();
  const { accounts } = useProviderAccounts();
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/provider-auth` as const;
  const state = useSWR(hasPermission("provider_accounts.read") ? path : null, requestState, {
    refreshInterval: (data) => (data?.operation?.hold ? 2000 : 0),
  });
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<{
    operationId: string;
    targetAccountId: string;
    expectedBindingRevision: number;
  } | null>(null);
  const { mutate } = state;
  useEffect(() => {
    void mutate();
  }, [mutate, recovery]);
  const parsedProvider = subscriptionProviderIdSchema.safeParse(model.split("/")[0]);
  if (!parsedProvider.success || !state.data) return null;
  const provider = parsedProvider.data;
  const binding = state.data.bindings.find((item) => item.provider === provider);
  if (binding?.authMode !== "provider_account") return null;
  const op = state.data.operation;
  const effectiveId =
    op && op.phase !== "applied" && op.phase !== "failed"
      ? op.sourceAccountId
      : binding.providerAccountId;
  const effective = accounts.find((account) => account.id === effectiveId);
  const alternatives = accounts.filter(
    (account) =>
      account.provider === provider &&
      account.id !== binding.providerAccountId &&
      account.status === "active" &&
      account.archivedAt === null
  );
  async function submit(resume: boolean) {
    if (busy || !binding) return;
    setBusy(true);
    setError(null);
    try {
      if (resume && op)
        await state.mutate(
          await requestState(`${path}/resume`, {
            operationId: op.operationId,
            bindingRevision: op.bindingRevision,
          }),
          false
        );
      else {
        if (
          !intent.current ||
          intent.current.targetAccountId !== target ||
          (intent.current.operationId === op?.operationId &&
            state.data?.preservation?.phase === "saved")
        )
          intent.current = {
            operationId: crypto.randomUUID(),
            targetAccountId: target,
            expectedBindingRevision: binding.bindingRevision ?? 1,
          };
        await state.mutate(await requestState(`${path}/${provider}/switch`, intent.current), false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Switch unavailable");
      await state.mutate();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Session provider account"
      className="border-b border-border-muted px-4 py-2 text-sm"
    >
      <div>
        Account: {effective?.displayName ?? "Connected account"}
        {op?.phase === "applying" ? " (new account not yet confirmed)" : ""}
      </div>
      {op?.hold && (
        <div role="status" className="space-y-2">
          <p>
            Execution paused: {op.phase.replaceAll("_", " ")}
            {op.reason ? ` — ${op.reason.replaceAll("_", " ")}` : ""}. Queued messages remain in
            order.
          </p>
          {op.phase === "applied" && canSwitch && (
            <>
              <button
                className="rounded border px-2 py-1"
                disabled={busy}
                onClick={() => void submit(true)}
              >
                {state.data.preservation?.phase === "saved"
                  ? "Restore and confirm account"
                  : state.data.pendingCount
                    ? "Resume queued work"
                    : "Continue with next message"}
              </button>
              <span className="ml-2">
                Stay paused by leaving this unchanged. The interrupted prompt will not be replayed.
              </span>
            </>
          )}
          {op.phase === "needs_reconciliation" && (
            <>
              <p>
                The account application is unconfirmed. Work is held; provider lifetime limits still
                apply.
              </p>
              {canSwitch && Date.now() < op.deadlineMs && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void requestState(`${path}/${op.provider}/switch`, {
                      operationId: op.operationId,
                      targetAccountId: op.targetAccountId,
                      expectedBindingRevision: op.expectedBindingRevision,
                    })
                      .then((next) => state.mutate(next, false))
                      .catch(() => setError("Recovery retry failed"))
                      .finally(() => setBusy(false));
                  }}
                >
                  Retry account application
                </button>
              )}
            </>
          )}
          {state.data.preservation && (
            <p>
              Workspace preservation: {state.data.preservation.phase}.
              {state.data.preservation.expiresAtMs
                ? ` Provider lifetime ends ${new Date(state.data.preservation.expiresAtMs).toLocaleString()}.`
                : " Provider lifetime limit is not finite or not yet known."}
              {state.data.preservation.hasRecoveryPoint
                ? " A recovery point is recorded; source retirement must also be confirmed before restore."
                : " No recovery point is confirmed yet."}
            </p>
          )}
        </div>
      )}
      {canSwitch && (!op?.hold || state.data.preservation?.phase === "saved") && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label>
            Switch account{" "}
            <select
              className="rounded border bg-background p-1"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                intent.current = null;
              }}
              disabled={busy || !state.data.switchAvailable}
            >
              <option value="">Choose account</option>
              {op?.hold && op.phase !== "applied" && (
                <option value={binding.providerAccountId}>Retry with current binding</option>
              )}
              {alternatives.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            className="rounded border px-2 py-1"
            disabled={busy || !target || !state.data.switchAvailable}
            onClick={() => void submit(false)}
          >
            Stop and switch
          </button>
          {!state.data.switchAvailable && <span>{state.data.unavailableReason}</span>}
          {!alternatives.length && <span>No compatible alternative account.</span>}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
