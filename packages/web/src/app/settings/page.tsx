"use client";

import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { SidebarLayout, useSidebarContext } from "@/components/sidebar-layout";
import { AnthropicConnection } from "@/components/anthropic-connection";

export default function SettingsPage() {
  return (
    <SidebarLayout>
      <SettingsContent />
    </SidebarLayout>
  );
}

function SettingsContent() {
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isOpen, toggle } = useSidebarContext();
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Handle OAuth callback messages
  useEffect(() => {
    const anthropicStatus = searchParams.get("anthropic");
    const error = searchParams.get("error");
    const description = searchParams.get("description");

    if (anthropicStatus === "connected") {
      setNotification({
        type: "success",
        message: "Successfully connected your Claude account.",
      });
      // Clear the URL params
      router.replace("/settings", { scroll: false });
    } else if (error) {
      let message = "Failed to connect Claude account.";
      if (error === "anthropic_auth_failed") {
        message = description ? `Authentication failed: ${description}` : "Authentication failed.";
      } else if (error === "state_mismatch") {
        message = "Security validation failed. Please try again.";
      } else if (error === "token_exchange_failed") {
        message = description ? `Token exchange failed: ${description}` : "Token exchange failed.";
      } else if (error === "not_configured") {
        message = "Anthropic OAuth is not configured on this server.";
      }
      setNotification({ type: "error", message });
      // Clear the URL params
      router.replace("/settings", { scroll: false });
    }
  }, [searchParams, router]);

  // Auto-dismiss notification after 5 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <button
              onClick={toggle}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              title="Open sidebar"
            >
              <SidebarToggleIcon />
            </button>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
            <p className="text-muted-foreground mt-1">
              Manage your account and connected services.
            </p>
          </div>

          {/* Notification */}
          {notification && (
            <div
              className={`px-4 py-3 text-sm ${
                notification.type === "success"
                  ? "bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400"
                  : "bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400"
              }`}
            >
              {notification.message}
            </div>
          )}

          {/* Account Section */}
          <section className="space-y-4">
            <h2 className="text-lg font-medium text-foreground">Account</h2>
            <div className="border border-border-muted p-6">
              <div className="flex items-center gap-4">
                {session?.user?.image && (
                  <img src={session.user.image} alt="Profile" className="w-12 h-12 rounded-full" />
                )}
                <div>
                  <div className="font-medium text-foreground">
                    {session?.user?.name || session?.user?.login}
                  </div>
                  <div className="text-sm text-muted-foreground">{session?.user?.email}</div>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-border-muted">
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="text-sm text-red-600 dark:text-red-400 hover:underline"
                >
                  Sign out
                </button>
              </div>
            </div>
          </section>

          {/* Connected Services Section */}
          <section className="space-y-4">
            <h2 className="text-lg font-medium text-foreground">Connected Services</h2>

            {/* GitHub (always connected since we use it for auth) */}
            <div className="border border-border-muted p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
                    <GitHubIcon />
                    GitHub
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Used for authentication and repository access.
                  </p>
                </div>
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-green-500/10 text-green-600 dark:text-green-400">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  Connected
                </div>
              </div>
              <div className="mt-3 text-sm text-muted-foreground">
                Connected as{" "}
                <span className="font-medium text-foreground">@{session?.user?.login}</span>
              </div>
            </div>

            {/* Anthropic/Claude */}
            <AnthropicConnection />
          </section>

          {/* About Section */}
          <section className="space-y-4">
            <h2 className="text-lg font-medium text-foreground">About</h2>
            <div className="border border-border-muted p-6 text-sm text-muted-foreground">
              <p>
                Open-Inspect is a background coding agent that helps your team ship faster with
                AI-powered code changes.
              </p>
              <p className="mt-2">
                <a
                  href="https://github.com/anthropics/background-agents"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  View on GitHub
                </a>
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path
        fillRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SidebarToggleIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}
