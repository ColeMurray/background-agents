"use client";

import { PlayIcon, XIcon } from "@/components/ui/icons";
import type { PendingAttachment } from "@/hooks/use-prompt-attachments";

function AttachmentPreview({
  attachment,
  onRemove,
  disabled,
}: {
  attachment: PendingAttachment;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="group/attachment relative w-16 h-16 border border-border bg-muted overflow-hidden flex-shrink-0"
      title={attachment.file.name}
    >
      {attachment.kind === "image" ? (
        <img
          src={attachment.previewUrl}
          alt={attachment.file.name}
          className="w-full h-full object-cover"
        />
      ) : (
        <>
          <video src={attachment.previewUrl} muted className="w-full h-full object-cover" />
          <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <PlayIcon className="w-5 h-5 text-white drop-shadow" />
          </span>
        </>
      )}
      {!disabled && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="absolute top-0.5 right-0.5 p-0.5 bg-background/80 text-secondary-foreground hover:text-foreground opacity-0 group-hover/attachment:opacity-100 focus-visible:opacity-100 transition"
          title={`Remove ${attachment.file.name}`}
          aria-label={`Remove ${attachment.file.name}`}
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Pending composer attachments: thumbnail previews with remove buttons plus
 * the validation/upload error line. Renders nothing when there is nothing to
 * show. Shared between the home (new session) and in-session composers.
 *
 * When `disabled` (a submit/upload is in flight), the remove buttons are hidden
 * so the draft can't diverge from the set being uploaded and sent.
 */
export function AttachmentPreviewStrip({
  items,
  error,
  onRemove,
  disabled,
}: {
  items: PendingAttachment[];
  error: string | null;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  if (items.length === 0 && !error) return null;

  return (
    <>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {items.map((attachment) => (
            <AttachmentPreview
              key={attachment.id}
              attachment={attachment}
              onRemove={onRemove}
              disabled={disabled}
            />
          ))}
        </div>
      )}
      {error && <p className="px-4 pt-2 text-xs text-destructive">{error}</p>}
    </>
  );
}
