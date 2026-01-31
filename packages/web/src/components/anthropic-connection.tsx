"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";

interface TokenStatus {
  connected: boolean;
  expiresAt?: number;
  isExpired?: boolean;
  hasRefreshToken?: boolean;
}

/**
 * Anthropic OAuth connection component.
 *
 * Displays connection status and provides connect/disconnect buttons.
 * When connected, your Claude API usage will be billed to your own account.
 */
export function AnthropicConnection() {
  const { data: session } = useSession();
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [codeVerifier, setCodeVerifier] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Fetch connection status on mount
  useEffect(() => {
    if (session?.user?.id) {
      fetchStatus();
    } else {
      setLoading(false);
    }
  }, [session?.user?.id]);

  async function fetchStatus() {
    try {
      const response = await fetch(`/api/settings/anthropic-status`);
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
      } else {
        setStatus({ connected: false });
      }
    } catch (err) {
      console.error("Failed to fetch Anthropic status:", err);
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!session?.user?.id) return;

    setDisconnecting(true);
    setError(null);

    try {
      const response = await fetch(`/api/settings/anthropic-disconnect`, {
        method: "POST",
      });

      if (response.ok) {
        setStatus({ connected: false });
      } else {
        const data = await response.json();
        setError(data.error || "Failed to disconnect");
      }
    } catch (err) {
      console.error("Failed to disconnect:", err);
      setError("Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleConnect() {
    setError(null);
    try {
      const response = await fetch("/api/auth/anthropic");
      if (!response.ok) {
        const text = await response.text();
        setError(text || "Failed to start authorization");
        return;
      }
      const data = await response.json();
      // Store the PKCE code verifier in state for the token exchange
      setCodeVerifier(data.codeVerifier);
      // Open Anthropic's authorization page in a new tab
      window.open(data.authorizeUrl, "_blank");
      // Show the code input field
      setShowCodeInput(true);
    } catch (err) {
      console.error("Failed to initiate OAuth:", err);
      setError("Failed to start authorization");
    }
  }

  async function handleSubmitCode() {
    if (!authCode.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/anthropic/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: authCode.trim(), codeVerifier }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setShowCodeInput(false);
        setAuthCode("");
        setCodeVerifier("");
        await fetchStatus();
      } else {
        const msg =
          typeof data.error === "string"
            ? data.error
            : typeof data.error === "object" && data.error?.message
              ? String(data.error.message)
              : "Failed to connect";
        setError(msg);
      }
    } catch (err) {
      console.error("Failed to submit code:", err);
      setError("Failed to submit authorization code");
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancelCodeInput() {
    setShowCodeInput(false);
    setAuthCode("");
    setCodeVerifier("");
    setError(null);
  }

  if (loading) {
    return (
      <div className="border border-border-muted p-6">
        <div className="flex items-center gap-3">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-foreground" />
          <span className="text-muted-foreground">Checking connection status...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-border-muted p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <AnthropicIcon />
            Claude Account
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Connect your Anthropic account to use your own API quota.
          </p>
        </div>
        <ConnectionStatus connected={status?.connected || false} />
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {status?.connected ? (
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            {status.isExpired ? (
              <span className="text-yellow-600 dark:text-yellow-400">
                Token expired. Please reconnect.
              </span>
            ) : status.expiresAt ? (
              <span>
                Token expires: {new Date(status.expiresAt).toLocaleDateString()}{" "}
                {new Date(status.expiresAt).toLocaleTimeString()}
              </span>
            ) : (
              <span>Connected</span>
            )}
          </div>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="text-sm text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
          >
            {disconnecting ? "Disconnecting..." : "Disconnect Claude Account"}
          </button>
        </div>
      ) : showCodeInput ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Paste the authorization code from the Anthropic page below:
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitCode();
              }}
              placeholder="Paste authorization code here"
              className="flex-1 border border-border-muted bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              disabled={submitting}
              autoFocus
            />
            <button
              onClick={handleSubmitCode}
              disabled={submitting || !authCode.trim()}
              className="bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit Code"}
            </button>
            <button
              onClick={handleCancelCodeInput}
              disabled={submitting}
              className="border border-border-muted px-4 py-2 text-sm font-medium hover:bg-muted transition disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={handleConnect}
          className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          <AnthropicIcon />
          Connect Claude Account
        </button>
      )}
    </div>
  );
}

function ConnectionStatus({ connected }: { connected: boolean }) {
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium ${
        connected
          ? "bg-green-500/10 text-green-600 dark:text-green-400"
          : "bg-muted text-muted-foreground"
      }`}
    >
      <div
        className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-muted-foreground"}`}
      />
      {connected ? "Connected" : "Not Connected"}
    </div>
  );
}

function AnthropicIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.604 3.117h-4.158L7.586 20.882h4.158l5.86-17.765ZM6.396 3.117H2.27l5.86 17.765h4.126L6.396 3.117Zm9.968 0 5.86 17.765h4.126l-5.86-17.765h-4.126Z" />
    </svg>
  );
}
