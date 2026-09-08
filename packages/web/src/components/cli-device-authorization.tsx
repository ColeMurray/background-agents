"use client";

import {
  pendingCliDeviceAuthorizationResponseSchema,
  type PendingCliDeviceAuthorizationResponse,
} from "@open-inspect/shared/types/cli-auth";
import { useEffect, useRef, useState } from "react";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { APP_NAME } from "@/lib/site-config";

interface CliDeviceAuthorizationProps {
  userCode: string;
  user: { name?: string | null; email?: string | null };
}

type Result =
  | { kind: "idle" }
  | { kind: "success" | "cancelled" }
  | { kind: "error"; message: string };

type PendingAuthorization =
  | { kind: "loading" }
  | ({ kind: "ready" } & PendingCliDeviceAuthorizationResponse)
  | { kind: "error"; message: string };

const ERROR_MESSAGES: Record<number, string> = {
  404: "This authorization code is invalid.",
  409: "This authorization code has already been used.",
  410: "This authorization code has expired.",
};

export function CliDeviceAuthorization({ userCode, user }: CliDeviceAuthorizationProps) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [pending, setPending] = useState<PendingAuthorization>({ kind: "loading" });
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (result.kind !== "idle") resultRef.current?.focus();
  }, [result]);

  useEffect(() => {
    let active = true;
    void browserApiFetch(
      `/api/cli/device-authorizations/pending?user_code=${encodeURIComponent(userCode)}`
    )
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          setPending({
            kind: "error",
            message:
              ERROR_MESSAGES[response.status] ?? "CLI authorization details could not be verified.",
          });
          return;
        }
        const authorization = pendingCliDeviceAuthorizationResponseSchema.parse(
          await response.json()
        );
        setPending(
          authorization.expiresAt <= Date.now()
            ? { kind: "error", message: ERROR_MESSAGES[410] }
            : { kind: "ready", ...authorization }
        );
      })
      .catch(() => {
        if (active) {
          setPending({
            kind: "error",
            message: "CLI authorization details are temporarily unavailable.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [userCode]);

  async function approve() {
    if (pending.kind !== "ready") return;
    setSubmitting(true);
    setResult({ kind: "idle" });
    try {
      const response = await browserApiFetch("/api/cli/device-authorizations/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode }),
      });
      if (response.ok) {
        setResult({ kind: "success" });
        return;
      }
      setResult({
        kind: "error",
        message: ERROR_MESSAGES[response.status] ?? "CLI authorization could not be completed.",
      });
    } catch {
      setResult({ kind: "error", message: "CLI authorization is temporarily unavailable." });
    } finally {
      setSubmitting(false);
    }
  }

  function closeWindow() {
    window.close();
  }

  function cancel() {
    setResult({ kind: "cancelled" });
    closeWindow();
  }

  if (result.kind === "success" || result.kind === "cancelled") {
    const success = result.kind === "success";
    return (
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-sm">
        <div
          ref={resultRef}
          role="status"
          tabIndex={-1}
          className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <h1 className="text-2xl font-semibold text-foreground">
            {success ? "CLI authorized" : "Authorization cancelled"}
          </h1>
          <p className="text-muted-foreground">
            {success
              ? "Return to your terminal to continue. You can close this window."
              : "Authorization cancelled. You can close this window."}
          </p>
        </div>
        <Button type="button" variant="outline" className="mt-6 w-full" onClick={closeWindow}>
          Close window
        </Button>
      </section>
    );
  }

  return (
    <section className="w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-sm">
      <div className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          Device authorization
        </p>
        <h1 className="text-2xl font-semibold text-foreground">Authorize {APP_NAME} CLI</h1>
        <p className="text-muted-foreground">
          A CLI device is requesting access to this {APP_NAME} installation as your account. Only
          approve if you started this request.
        </p>
        <p className="text-sm text-muted-foreground">
          The CLI and connected AI clients inherit your current workspace role. They can use every
          operation that role permits on the external interface, including creating, prompting, and
          stopping sessions.
        </p>
      </div>

      <dl className="my-7 space-y-4 rounded-lg bg-muted p-5">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Installation
          </dt>
          <dd className="mt-1 font-medium text-foreground">
            {pending.kind === "ready" ? pending.installation.name : "Checking request..."}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Signed in as
          </dt>
          <dd className="mt-1 font-medium text-foreground">{user.name || user.email || "User"}</dd>
          {user.name && user.email && (
            <dd className="text-sm text-muted-foreground">{user.email}</dd>
          )}
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Requesting device
          </dt>
          <dd className="mt-1 font-medium text-foreground">
            {pending.kind === "ready" ? pending.deviceName : "Checking request..."}
          </dd>
        </div>
        {pending.kind === "ready" && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Expires
            </dt>
            <dd className="mt-1 text-foreground">
              <time dateTime={new Date(pending.expiresAt).toISOString()}>
                {new Date(pending.expiresAt).toLocaleString()}
              </time>
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Authorization code
          </dt>
          <dd
            aria-label="Authorization code"
            className="mt-1 font-mono text-xl font-semibold tracking-wider text-foreground"
          >
            {userCode}
          </dd>
        </div>
      </dl>

      {result.kind === "error" && (
        <ErrorBanner ref={resultRef} role="alert" tabIndex={-1} className="mb-5 outline-none">
          {result.message}
        </ErrorBanner>
      )}
      {pending.kind === "error" && result.kind === "idle" && (
        <ErrorBanner role="alert" className="mb-5">
          {pending.message}
        </ErrorBanner>
      )}

      {submitting && (
        <p role="status" className="sr-only">
          Approving CLI access
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Button type="button" variant="outline" disabled={submitting} onClick={cancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={submitting || pending.kind !== "ready"}
          onClick={() => void approve()}
        >
          {submitting ? "Approving..." : "Approve"}
        </Button>
      </div>
    </section>
  );
}
