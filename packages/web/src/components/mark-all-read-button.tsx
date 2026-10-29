"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CheckCheckIcon } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const ACTION_LABEL = "Mark all as read";

interface MarkAllReadButtonProps {
  /** Sessions that will be marked, or null when some are on pages not loaded yet. */
  count: number | null;
  /** Names the active filters; omitted when nothing narrows the list. */
  scopeLabel?: string;
  onConfirm: () => Promise<unknown>;
}

function confirmationTitle(count: number | null): string {
  if (count === null) return "Mark all sessions as read?";
  return `Mark ${count} ${count === 1 ? "session" : "sessions"} as read?`;
}

/** Icon trigger and confirmation popover for marking a whole inbox section read. */
export function MarkAllReadButton({ count, scopeLabel, onConfirm }: MarkAllReadButtonProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const handleConfirm = async () => {
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch (error) {
      console.error("Failed to mark sessions as read", error);
      toast.error("Couldn't mark sessions as read");
    } finally {
      setPending(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={ACTION_LABEL}
                // Revealed by hovering or focusing the nearest `group`; always
                // shown on touch devices, which cannot hover.
                className={`flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground ${
                  open
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                }`}
              >
                <CheckCheckIcon className="h-4 w-4" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{ACTION_LABEL}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent align="end" className="w-56 p-3">
        <p className="text-sm font-semibold text-foreground">{confirmationTitle(count)}</p>
        {scopeLabel && <p className="mt-0.5 text-xs text-muted-foreground">{scopeLabel}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <Button size="xs" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="xs" disabled={pending} onClick={() => void handleConfirm()}>
            {pending ? "Marking…" : "Mark read"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
