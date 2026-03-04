"use client";

import type { PendingAttachment } from "@/hooks/use-file-upload";

interface AttachmentPreviewProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 py-2 border-t border-border-muted">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="relative group flex items-center gap-2 rounded border border-border-muted bg-muted px-2 py-1 text-xs"
        >
          {att.previewUrl ? (
            <img src={att.previewUrl} alt={att.name} className="w-8 h-8 rounded object-cover" />
          ) : (
            <FileIcon className="w-4 h-4 text-muted-foreground" />
          )}
          <span className="max-w-[120px] truncate text-muted-foreground">{att.name}</span>
          {att.uploading && <Spinner />}
          {att.error && (
            <span className="text-red-500" title={att.error}>
              !
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemove(att.id)}
            className="ml-1 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label={`Remove ${att.name}`}
          >
            <XIcon className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" />
      <path d="M9 1v4h4" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin text-muted-foreground" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
