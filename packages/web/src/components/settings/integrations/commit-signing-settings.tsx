"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { commitSigningMetadataSchema } from "@open-inspect/shared";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const SETTINGS_KEY = "/api/commit-signing";

export function CommitSigningSettings() {
  const { data: rawData, isLoading, mutate } = useSWR<unknown>(SETTINGS_KEY);
  const data = useMemo(() => {
    const result = commitSigningMetadataSchema.safeParse(rawData);
    return result.success ? result.data : undefined;
  }, [rawData]);
  const [githubLogin, setGithubLogin] = useState("");
  const [committerName, setCommitterName] = useState("");
  const [committerEmail, setCommitterEmail] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [showDisableDialog, setShowDisableDialog] = useState(false);

  useEffect(() => {
    if (!data?.enabled) return;
    setGithubLogin(data.githubLogin);
    setCommitterName(data.committerName);
    setCommitterEmail(data.committerEmail);
  }, [data]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const saveResponse = await fetch(SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privateKey, githubLogin, committerName, committerEmail }),
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
      setGithubLogin("");
      setCommitterName("");
      setCommitterEmail("");
      setPrivateKey("");
      toast.success("Commit signing disabled.");
    } catch {
      toast.error("Commit signing service unavailable");
    } finally {
      setShowDisableDialog(false);
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

      <p className="mt-4 text-sm font-medium text-foreground">
        {isLoading ? "Loading…" : data?.enabled ? "Configured" : "Not configured"}
      </p>

      {data?.enabled && (
        <dl className="mt-3 grid gap-2 text-sm">
          <div>
            <dt className="inline text-muted-foreground">Signing account: </dt>
            <dd className="inline">{data.githubLogin}</dd>
          </div>
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
            <dt className="inline text-muted-foreground">Validation: </dt>
            <dd className="inline">Valid · {new Date(data.validatedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Updated: </dt>
            <dd className="inline">{new Date(data.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      )}

      <ol className="mt-4 list-decimal pl-5 text-sm text-muted-foreground space-y-1">
        <li>Create or recover the dedicated GitHub signing account.</li>
        <li>Add the matching public key to that account as a signing key.</li>
        <li>Save the private key here, then run the documented GitHub smoke test.</li>
        <li>For rotation, register the new public key before replacing this configuration.</li>
      </ol>

      <div className="mt-4 grid gap-4 max-w-2xl">
        <label className="grid gap-1.5 text-sm">
          <span>GitHub signing account</span>
          <Input
            value={githubLogin}
            onChange={(event) => setGithubLogin(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span>Committer name</span>
          <Input
            value={committerName}
            onChange={(event) => setCommitterName(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span>Committer email</span>
          <Input
            type="email"
            value={committerEmail}
            onChange={(event) => setCommitterEmail(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span>OpenSSH Ed25519 private key</span>
          <Textarea
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || !privateKey || !githubLogin || !committerName || !committerEmail}
          >
            {saving ? "Saving…" : "Save signing configuration"}
          </Button>
          {data?.enabled && (
            <Button
              type="button"
              variant="outline"
              className="ml-2"
              onClick={() => setShowDisableDialog(true)}
              disabled={saving}
            >
              Disable commit signing
            </Button>
          )}
        </div>
      </div>

      <AlertDialog open={showDisableDialog} onOpenChange={setShowDisableDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable commit signing?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the stored signing-key ciphertext. New prompts will return to unsigned
              commit behavior.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisable}>Disable signing</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
