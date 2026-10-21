"use client";

import { Button } from "@/components/ui/button";

export function DiffRefreshNotice({
  message,
  pendingMessage,
  isPending,
  onRetry,
}: {
  message: string;
  pendingMessage: string;
  isPending: boolean;
  onRetry: () => Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <p>{isPending ? pendingMessage : message}</p>
      <Button size="xs" variant="outline" disabled={isPending} onClick={() => void onRetry()}>
        {isPending ? "Refreshing…" : "Retry refresh"}
      </Button>
    </div>
  );
}
