"use client";

import Link from "next/link";
import { useAuthSession } from "@/lib/auth-session";
import { APP_NAME } from "@/lib/site-config";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

/**
 * Renders application children only for authenticated, active workspace users after authorization resolves.
 */
export function AppAuthBoundary({ children }: { children: React.ReactNode }) {
  const { status } = useAuthSession();
  const { authorization, loading: authorizationLoading, error } = useCurrentUserAuthorization();

  if (status === "loading") {
    return (
      <div
        role="status"
        aria-label="Checking authentication"
        className="min-h-screen flex items-center justify-center"
      >
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-foreground" />
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-6">
        <h1 className="text-4xl font-bold text-foreground">{APP_NAME}</h1>
        <ErrorBanner role="alert" className="max-w-md px-6 py-4 text-center">
          Authentication is temporarily unavailable.
        </ErrorBanner>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-8">
        <h1 className="text-4xl font-bold text-foreground">{APP_NAME}</h1>
        <p className="text-muted-foreground max-w-md text-center">
          Background coding agent for your team. Ship faster with AI-powered code changes.
        </p>
        <Button asChild className="px-6 py-3">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  if (status === "authenticated") {
    if (authorizationLoading) {
      return (
        <div
          role="status"
          aria-label="Checking authorization"
          className="min-h-screen flex items-center justify-center"
        >
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-foreground" />
        </div>
      );
    }
    if (error || !authorization) {
      return (
        <div className="min-h-screen flex items-center justify-center px-6">
          <ErrorBanner role="alert">Authorization is temporarily unavailable.</ErrorBanner>
        </div>
      );
    }
    if (authorization.suspendedAt !== null) {
      return (
        <div className="min-h-screen flex items-center justify-center px-6">
          <ErrorBanner role="alert">Your workspace access is disabled.</ErrorBanner>
        </div>
      );
    }
    return children;
  }

  status satisfies never;
  throw new Error("Unhandled authentication state");
}
