"use client";

import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";

export default function SessionError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <ErrorBanner
        role="alert"
        className="flex max-w-md flex-col items-center gap-4 p-6 text-center"
      >
        <p>Session data is temporarily unavailable.</p>
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      </ErrorBanner>
    </div>
  );
}
