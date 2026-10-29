"use client";

import { ConfirmationDialog } from "@/components/confirmation-dialog";

interface ArchiveSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ArchiveSessionDialog({ open, onOpenChange, onConfirm }: ArchiveSessionDialogProps) {
  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Archive session"
      description="Archive this session? You can restore archived sessions from Settings > Data Controls."
      actionLabel="Archive"
      onConfirm={onConfirm}
    />
  );
}
