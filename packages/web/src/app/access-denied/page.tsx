"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function AccessDeniedContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  // NextAuth passes error=AccessDenied when signIn callback returns false
  const message =
    error === "AccessDenied"
      ? "Your account is not authorized to use this application."
      : "An error occurred during sign in. Please try again.";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-bold text-foreground">Access Denied</h1>
      <div className="bg-destructive-muted border border-destructive/40 px-6 py-4 text-destructive max-w-md text-center">
        {message}
      </div>
      <a href="/" className="text-accent hover:underline">
        Return to homepage
      </a>
    </div>
  );
}

export default function AccessDeniedPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
        </div>
      }
    >
      <AccessDeniedContent />
    </Suspense>
  );
}
