"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface WebhookConfigProps {
  webhookUrl?: string;
  webhookApiKey?: string;
  automationId?: string;
  onRegenerate?: () => Promise<{ webhookApiKey: string; webhookUrl: string }>;
}

export function WebhookConfig({
  webhookUrl,
  webhookApiKey,
  automationId: _automationId,
  onRegenerate,
}: WebhookConfigProps) {
  const [currentKey, setCurrentKey] = useState(webhookApiKey);
  const [currentUrl, setCurrentUrl] = useState(webhookUrl);
  const [regenerating, setRegenerating] = useState(false);
  const [copied, setCopied] = useState<"url" | "key" | "curl" | null>(null);

  const handleCopy = async (text: string, type: "url" | "key" | "curl") => {
    await navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleRegenerate = async () => {
    if (!onRegenerate) return;
    setRegenerating(true);
    try {
      const result = await onRegenerate();
      setCurrentKey(result.webhookApiKey);
      setCurrentUrl(result.webhookUrl);
    } finally {
      setRegenerating(false);
    }
  };

  const curlCommand =
    currentUrl && currentKey
      ? `curl -X POST "${currentUrl}" \\\n  -H "Authorization: Bearer ${currentKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"test": true}'`
      : "";

  if (!currentUrl && !currentKey) {
    return (
      <div className="text-sm text-muted-foreground p-4 border border-border-muted rounded-md">
        Webhook URL and API key will be shown after the automation is created.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 border border-border-muted rounded-md bg-background">
      {/* Webhook URL */}
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">Webhook URL</label>
        <div className="flex gap-2">
          <Input type="text" value={currentUrl || ""} readOnly className="text-xs font-mono" />
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => handleCopy(currentUrl || "", "url")}
          >
            {copied === "url" ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      {/* API Key */}
      {currentKey && (
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">API Key</label>
          <div className="flex gap-2">
            <Input type="text" value={currentKey} readOnly className="text-xs font-mono" />
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => handleCopy(currentKey, "key")}
            >
              {copied === "key" ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Save this key — it won&apos;t be shown again after you leave this page.
          </p>
        </div>
      )}

      {/* Regenerate + curl */}
      <div className="flex items-center gap-2">
        {onRegenerate && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleRegenerate}
            disabled={regenerating}
          >
            {regenerating ? "Regenerating..." : "Regenerate Key"}
          </Button>
        )}
        {curlCommand && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => handleCopy(curlCommand, "curl")}
          >
            {copied === "curl" ? "Copied" : "Copy curl"}
          </Button>
        )}
      </div>
    </div>
  );
}
