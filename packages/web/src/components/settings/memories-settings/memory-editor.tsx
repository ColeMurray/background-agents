"use client";

import { useState } from "react";
import {
  MEMORY_LIMITS,
  MEMORY_TYPES,
  memoryContentSchema,
  memoryTypeSchema,
  type MemoryContent,
} from "@open-inspect/shared/types/memories";
import { memoryTypeLabel } from "@/lib/memories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

/** Validate editable content locally; the parent owns scope, transport, and server errors. */
export function MemoryEditor({
  record,
  busy,
  onSave,
  onCancel,
}: {
  record?: MemoryContent;
  busy: boolean;
  onSave: (content: MemoryContent) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<MemoryContent>({
    memoryType: record?.memoryType ?? "fact",
    title: record?.title ?? "",
    description: record?.description ?? "",
    content: record?.content ?? "",
  });
  const [error, setError] = useState("");
  const limit = MEMORY_LIMITS[draft.memoryType];
  return (
    <form
      className="space-y-4 rounded-sm border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = memoryContentSchema.safeParse(draft);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Invalid memory");
          return;
        }
        setError("");
        onSave(parsed.data);
      }}
    >
      <h3 className="font-medium">{record ? "Edit memory" : "New memory"}</h3>
      <Select
        value={draft.memoryType}
        onValueChange={(value) => {
          const memoryType = memoryTypeSchema.safeParse(value);
          if (memoryType.success) setDraft({ ...draft, memoryType: memoryType.data });
        }}
        disabled={busy}
      >
        <SelectTrigger aria-label="Memory type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MEMORY_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {memoryTypeLabel(type)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="block text-sm">
        Title{" "}
        <span className="text-muted-foreground">
          {draft.title.length}/{MEMORY_LIMITS.title}
        </span>
        <Input
          value={draft.title}
          maxLength={MEMORY_LIMITS.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          disabled={busy}
        />
      </label>
      <label className="block text-sm">
        Description{" "}
        <span className="text-muted-foreground">
          {draft.description.length}/{MEMORY_LIMITS.description}
        </span>
        <Input
          value={draft.description}
          maxLength={MEMORY_LIMITS.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          disabled={busy}
        />
        <span className="text-xs text-muted-foreground">
          At least {MEMORY_LIMITS.descriptionMin} characters. Helps the agent decide when this is
          relevant.
        </span>
      </label>
      <label className="block text-sm">
        Content{" "}
        <span className="text-muted-foreground">
          {draft.content.length}/{limit}
        </span>
        <Textarea
          rows={8}
          value={draft.content}
          maxLength={limit}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          disabled={busy}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save memory"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
