"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";

// Reasons match the control plane's sign-in failure redirect.
function signInFailureMessage(error: string | null, provider: string | null): string {
  switch (error) {
    case "AccessDenied":
    case "access_denied":
      return "Your account is not authorized to use this application.";
    case "provider_rejected":
      return provider === "github"
        ? "GitHub did not allow this application to read your verified email addresses. An administrator should check that the GitHub App has the Account permission 'Email addresses: Read-only'."
        : "The sign-in provider rejected a request that sign-in needs. Please contact an administrator.";
    case "provider_unavailable":
    case "admission_unavailable":
      return "Sign-in could not be completed right now. Please try again in a moment.";
    default:
      return "An error occurred during sign in. Please try again.";
  }
}

function AccessDeniedContent() {
  const searchParams = useSearchParams();
  const message = signInFailureMessage(searchParams.get("error"), searchParams.get("provider"));

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-bold text-foreground">Access Denied</h1>
      <ErrorBanner className="max-w-md px-6 py-4 text-center">{message}</ErrorBanner>
      <Link href="/" className="text-accent hover:underline">
        Return to homepage
      </Link>
    </div>
  );
}

export default function AccessDeniedPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-foreground" />
        </div>
      }
    >
      <AccessDeniedContent />
    </Suspense>
  );
}
