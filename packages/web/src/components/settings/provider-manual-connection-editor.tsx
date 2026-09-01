"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ConnectModelProviderAccountRequest,
  ModelProviderAccount,
  ReconnectModelProviderAccountRequest,
} from "@open-inspect/shared/types/provider-accounts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ManualProviderConnectionTarget =
  | { provider: "openai"; operation: "create" }
  | { provider: "openai" | "xai"; operation: "reconnect"; account: ModelProviderAccount };

export type ManualProviderConnectionSubmit =
  | {
      operation: "create";
      input: Extract<ConnectModelProviderAccountRequest, { provider: "openai" }>;
    }
  | {
      operation: "reconnect";
      providerAccountId: string;
      input: ReconnectModelProviderAccountRequest;
    };

export function ProviderManualConnectionEditor({
  target,
  saving,
  onSubmit,
  onCancel,
}: {
  target: ManualProviderConnectionTarget;
  saving: boolean;
  onSubmit: (submission: ManualProviderConnectionSubmit) => void;
  onCancel: () => void;
}) {
  const account = target.operation === "reconnect" ? target.account : undefined;
  const [displayName, setDisplayName] = useState(account?.displayName ?? "ChatGPT account");
  const [refreshToken, setRefreshToken] = useState("");
  const [accountId, setAccountId] = useState(account?.externalAccountId ?? "");
  const isOpenAI = target.provider === "openai";
  const initialFocusRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => initialFocusRef.current?.focus());
    return () => clearTimeout(timer);
  }, []);

  const submit = () => {
    if (target.operation === "create") {
      onSubmit({
        operation: "create",
        input: {
          provider: "openai",
          displayName: displayName.trim(),
          refreshToken,
          accountId: accountId.trim(),
        },
      });
      return;
    }
    onSubmit({
      operation: "reconnect",
      providerAccountId: target.account.id,
      input:
        target.provider === "openai"
          ? { provider: "openai", refreshToken, accountId: accountId.trim() }
          : { provider: "xai", refreshToken },
    });
  };

  return (
    <form
      className="space-y-3 rounded-md border border-border-muted p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <h3 className="font-medium">
          {target.operation === "create"
            ? "Connect ChatGPT manually"
            : `Reconnect ${target.account.displayName}${isOpenAI ? " manually" : ""}`}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {isOpenAI
            ? "Use this fallback only when device authorization is unavailable. The refresh token is write-only and the account identity is verified by OpenAI."
            : "This legacy account predates device authorization. Enter a fresh xAI refresh token once; new SuperGrok accounts connect through xAI directly."}
        </p>
      </div>
      {target.operation === "create" && (
        <div>
          <Label htmlFor="provider-display-name">Account name</Label>
          <Input
            id="provider-display-name"
            ref={initialFocusRef}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
      )}
      {isOpenAI && (
        <div>
          <Label htmlFor="provider-account-id">Account ID</Label>
          <Input
            id="provider-account-id"
            ref={target.operation === "reconnect" ? initialFocusRef : undefined}
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          />
        </div>
      )}
      <div>
        <Label htmlFor="provider-refresh-token">Refresh token</Label>
        <Input
          id="provider-refresh-token"
          ref={!isOpenAI ? initialFocusRef : undefined}
          type="password"
          autoComplete="off"
          value={refreshToken}
          onChange={(event) => setRefreshToken(event.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={
            saving ||
            !refreshToken ||
            (target.operation === "create" && !displayName.trim()) ||
            (isOpenAI && !accountId.trim())
          }
        >
          Save
        </Button>
        <Button type="button" size="sm" variant="subtle" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
