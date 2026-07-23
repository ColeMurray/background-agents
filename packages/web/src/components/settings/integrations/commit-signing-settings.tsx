"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { commitSigningMetadataSchema } from "@open-inspect/shared";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const SETTINGS_KEY = "/api/commit-signing";

type SigningViewStateKind = "loading" | "error" | "invalid" | "disabled" | "enabled";

const STATUS_LABELS: Record<SigningViewStateKind, string> = {
  loading: "Loading…",
  error: "Unable to load configuration",
  invalid: "Invalid service response",
  disabled: "Not configured",
  enabled: "Configured",
};

export function CommitSigningSettings() {
  const { data: rawData, error, isLoading, mutate } = useSWR<unknown>(SETTINGS_KEY);
  const viewState = useMemo(() => {
    if (isLoading) return { kind: "loading" } as const;
    if (error) return { kind: "error" } as const;
    const result = commitSigningMetadataSchema.safeParse(rawData);
    if (!result.success) return { kind: "invalid" } as const;
    return result.data.enabled
      ? ({ kind: "enabled", data: result.data } as const)
      : ({ kind: "disabled" } as const);
  }, [error, isLoading, rawData]);
  const data = viewState.kind === "enabled" ? viewState.data : undefined;
  const configurationKnown = viewState.kind === "enabled" || viewState.kind === "disabled";
  const [committerName, setCommitterName] = useState("");
  const [committerEmail, setCommitterEmail] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data?.enabled) return;
    setCommitterName(data.committerName);
    setCommitterEmail(data.committerEmail);
  }, [data]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const saveResponse = await fetch(SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privateKey, committerName, committerEmail }),
      });
      if (!saveResponse.ok) {
        toast.error(
          saveResponse.status === 400
            ? "Enter a valid, unencrypted OpenSSH Ed25519 private key and signing identity."
            : "Failed to save signing configuration."
        );
        return;
      }

      const result: unknown = await saveResponse.json();
      const metadata = commitSigningMetadataSchema.safeParse(result);
      if (!metadata.success) {
        toast.error("Invalid response from commit signing service");
        return;
      }
      await mutate(metadata.data, false);
      toast.success("Commit signing configured.");
    } catch {
      toast.error("Commit signing service unavailable");
    } finally {
      setPrivateKey("");
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    setSaving(true);
    try {
      const disableResponse = await fetch(SETTINGS_KEY, { method: "DELETE" });
      if (!disableResponse.ok) {
        toast.error("Failed to disable commit signing.");
        return;
      }
      const result: unknown = await disableResponse.json();
      const metadata = commitSigningMetadataSchema.safeParse(result);
      if (!metadata.success) {
        toast.error("Invalid response from commit signing service");
        return;
      }
      await mutate(metadata.data, false);
      setCommitterName("");
      setCommitterEmail("");
      setPrivateKey("");
      toast.success("Commit signing disabled.");
    } catch {
      toast.error("Commit signing service unavailable");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border-t border-border pt-6 mt-6" aria-labelledby="commit-signing-title">
      <h4 id="commit-signing-title" className="text-base font-medium text-foreground">
        Commit signing
      </h4>
      <p className="mt-1 text-sm text-muted-foreground">
        Sign agent commits with one dedicated GitHub machine account while retaining trusted users
        as commit authors.
      </p>

      <p className="mt-4 text-sm font-medium text-foreground">{STATUS_LABELS[viewState.kind]}</p>

      {data?.enabled && (
        <dl className="mt-3 grid gap-2 text-sm">
          <div>
            <dt className="inline text-muted-foreground">Committer: </dt>
            <dd className="inline">
              {data.committerName} &lt;{data.committerEmail}&gt;
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Fingerprint: </dt>
            <dd className="inline font-mono break-all">{data.fingerprint}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Public key: </dt>
            <dd className="inline font-mono break-all">{data.publicKey}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Updated: </dt>
            <dd className="inline">{new Date(data.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      )}

      <div className="mt-4 grid gap-4 max-w-2xl">
        <label className="grid gap-1.5 text-sm">
          <span>Committer name</span>
          <Input
            value={committerName}
            onChange={(event) => setCommitterName(event.target.value)}
            autoComplete="off"
            disabled={!configurationKnown}
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span>Committer email</span>
          <Input
            type="email"
            value={committerEmail}
            onChange={(event) => setCommitterEmail(event.target.value)}
            autoComplete="off"
            disabled={!configurationKnown}
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span>OpenSSH Ed25519 private key</span>
          <Textarea
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={!configurationKnown}
          />
        </label>
        <div>
          <Button
            type="button"
            onClick={handleSave}
            disabled={
              !configurationKnown || saving || !privateKey || !committerName || !committerEmail
            }
          >
            {saving ? "Saving…" : "Save signing configuration"}
          </Button>
          {data?.enabled && (
            <Button
              type="button"
              variant="outline"
              className="ml-2"
              onClick={handleDisable}
              disabled={saving}
            >
              Disable commit signing
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
