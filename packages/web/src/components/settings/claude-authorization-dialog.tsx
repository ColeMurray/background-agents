"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { connectProviderAccount, reconnectProviderAccount } from "@/hooks/use-provider-accounts";
import {
  createClaudePkce,
  parseClaudeAuthorizationResponse,
  type ClaudePkce,
} from "@/lib/claude-pkce";
import { SubscriptionProviderIcon } from "@/components/subscription-provider-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type ClaudeAuthorizationTarget =
  | { operation: "create" }
  | { operation: "reconnect"; providerAccountId: string; displayName: string };

export function ClaudeAuthorizationDialog({
  target,
  onConnected,
  onClose,
}: {
  target: ClaudeAuthorizationTarget;
  onConnected: (operation: ClaudeAuthorizationTarget["operation"]) => void;
  onClose: () => void;
}) {
  const [pkce, setPkce] = useState<ClaudePkce | null>(null);
  const [response, setResponse] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void createClaudePkce()
      .then((result) => {
        if (active) setPkce(result);
      })
      .catch((error) => {
        if (active)
          setFailure(error instanceof Error ? error.message : "Could not prepare authorization.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pkce || submittingRef.current) return;

    setFailure(null);
    let parsed: ReturnType<typeof parseClaudeAuthorizationResponse>;
    try {
      parsed = parseClaudeAuthorizationResponse(response);
      if (parsed.state !== pkce.state) {
        throw new Error(
          "Authorization state does not match. Start the Claude authorization again."
        );
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Invalid authorization response.");
      return;
    }

    submittingRef.current = true;
    setSaving(true);
    try {
      const credentials = {
        provider: "anthropic" as const,
        authorizationCode: parsed.authorizationCode,
        codeVerifier: pkce.codeVerifier,
        state: parsed.state,
      };
      if (target.operation === "create") {
        await connectProviderAccount({
          ...credentials,
          displayName: "Claude account",
        });
      } else {
        await reconnectProviderAccount(target.providerAccountId, credentials);
      }
      onConnected(target.operation);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Claude account request failed.");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto p-0 sm:w-full">
        <div className="border-b border-border-muted bg-muted/30 px-5 py-5 sm:px-7">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background">
              <SubscriptionProviderIcon provider="anthropic" className="size-5 text-foreground" />
            </div>
            <div>
              <DialogTitle>
                {target.operation === "create"
                  ? "Connect your Claude account"
                  : `Reconnect ${target.displayName}`}
              </DialogTitle>
              <DialogDescription className="mt-1">
                Authorize Claude using a browser-generated PKCE code. Your Claude tokens are
                exchanged and stored by the control plane, never this browser.
              </DialogDescription>
            </div>
          </div>
        </div>

        <form className="space-y-4 px-5 py-5 sm:px-7" onSubmit={submit}>
          <div className="rounded-md border border-warning/30 bg-warning-muted px-4 py-3 text-sm text-warning">
            Anthropic must approve this OAuth client for deployment. This integration is not
            officially supported by Anthropic and may stop working.
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">1. Authorize with Claude</h3>
            <p className="text-sm text-muted-foreground">
              Open Claude in a new tab and complete the authorization. Keep this dialog open.
            </p>
            {pkce ? (
              <Button asChild size="sm" variant="outline">
                <a href={pkce.authorizationUrl} target="_blank" rel="noopener noreferrer">
                  Open Claude Authorization
                </a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled>
                Preparing authorization...
              </Button>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">2. Paste the response</h3>
            <p className="text-sm text-muted-foreground">
              Paste either the full callback URL or the returned value in code#state format.
            </p>
            <Label htmlFor="claude-authorization-response">Authorization response</Label>
            <Textarea
              id="claude-authorization-response"
              autoComplete="off"
              spellCheck={false}
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              placeholder="code#state or https://platform.claude.com/oauth/code/callback?..."
              className="min-h-24 font-mono text-xs"
            />
          </section>

          {failure && <p className="text-sm text-destructive">{failure}</p>}

          <div className="flex justify-end gap-2 border-t border-border-muted pt-4">
            <Button type="button" size="sm" variant="subtle" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!pkce || !response.trim() || saving}>
              {saving ? "Connecting..." : target.operation === "create" ? "Connect" : "Reconnect"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
