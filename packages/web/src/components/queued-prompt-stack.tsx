"use client";

import { ClockIcon } from "@/components/ui/icons";
import type { PromptQueueItem } from "@open-inspect/shared/types/server-messages";

export function QueuedPromptStack({ promptQueue }: { promptQueue: PromptQueueItem[] }) {
  const pendingPrompts = promptQueue.filter((item) => item.status === "pending");
  if (pendingPrompts.length === 0) return null;

  return (
    <section aria-label="Queued prompts" className="mx-auto w-full min-w-0 max-w-4xl px-4 pt-3">
      <div className="max-h-48 overflow-y-auto rounded-t-xl border border-b-0 border-border bg-card/95 px-3 pb-3 pt-2 shadow-[0_-8px_30px_-22px_rgba(0,0,0,0.45)] backdrop-blur-sm">
        <ol className="divide-y divide-border-muted">
          {pendingPrompts.map((prompt) => (
            <li
              key={prompt.messageId}
              className="flex min-w-0 items-start gap-2 py-2.5 first:pt-1.5"
            >
              <ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/70" />
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-secondary-foreground">
                {prompt.content}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
