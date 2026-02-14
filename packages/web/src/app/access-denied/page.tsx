"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function AccessDeniedContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  // nextauth passes error=AccessDenied when signIn callback returns false
  const message =
    error === "AccessDenied"
      ? "Your account is not authorized to use this application."
      : "An error occurred during sign in. Please try again.";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-clay-100">
      <h1 className="text-4xl font-bold text-ash-900 font-clash">Access Denied</h1>
      <div className="bg-lava-100 border border-lava-200 rounded-lg px-6 py-4 text-lava-700 max-w-md text-center">
        {message}
      </div>
      <a href="/" className="text-rebolt-500 hover:underline">
        Return to homepage
      </a>
    </div>
  );
}

export default function AccessDeniedPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-clay-100">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ash-900" />
        </div>
      }
    >
      <AccessDeniedContent />
    </Suspense>
  );
}
