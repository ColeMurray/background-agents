"use client";

import { useRef, useState } from "react";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export function SnapshotRetryButton({
  sessionId,
  disabled,
}: {
  sessionId: string;
  disabled: boolean;
}) {
  const [isRetrying, setIsRetrying] = useState(false);
  const retryPendingRef = useRef(false);

  const retry = async () => {
    if (retryPendingRef.current) return;
    retryPendingRef.current = true;
    setIsRetrying(true);
    try {
      const response = await browserApiFetch(`/api/sessions/${sessionId}/retry-snapshot`, {
        method: "POST",
      });
      if (response.ok) return;
    } catch {
      /* A lost response does not authorize another artifact or clean launch. */
    } finally {
      retryPendingRef.current = false;
      setIsRetrying(false);
    }
    window.alert(
      "Recovery remains blocked. The snapshot reference is retained; contact your operator."
    );
  };

  return (
    <button
      type="button"
      className="mt-2 underline disabled:opacity-50"
      disabled={disabled || isRetrying}
      onClick={() => void retry()}
    >
      {isRetrying ? "Retrying snapshot…" : "Retry the existing snapshot"}
    </button>
  );
}
