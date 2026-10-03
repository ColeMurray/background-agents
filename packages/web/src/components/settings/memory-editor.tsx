"use client";

import { useState } from "react";
import {
  memoryContentSchema,
  MEMORY_LIMITS,
  type MemoryContent,
  type MemoryView,
} from "@open-inspect/shared/types/memories";
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

/** Validate editable content locally; the parent owns scope, provenance, and revision fencing. */
export function MemoryEditor({
  record,
  onSave,
  onCancel,
}: {
  record?: MemoryView;
  onSave: (content: MemoryContent) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<MemoryContent>({
    memoryType: record?.memoryType ?? "fact",
    title: record?.title ?? "",
    description: record?.description ?? "",
    content: record?.content ?? "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const limit = MEMORY_LIMITS[draft.memoryType];
  return (
    <form
      className="space-y-4 rounded-sm border border-border p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const parsed = memoryContentSchema.safeParse(draft);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Invalid memory");
          return;
        }
        setSaving(true);
        setError("");
        try {
          await onSave(parsed.data);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Save failed");
        } finally {
          setSaving(false);
        }
      }}
    >
      <h3 className="font-medium">{record ? "Edit memory" : "New memory"}</h3>
      <Select
        value={draft.memoryType}
        onValueChange={(value) =>
          setDraft({ ...draft, memoryType: value === "directive" ? "directive" : "fact" })
        }
        disabled={saving}
      >
        <SelectTrigger aria-label="Memory type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fact">Fact · read when relevant</SelectItem>
          <SelectItem value="directive">Directive · always included</SelectItem>
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
          disabled={saving}
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
          disabled={saving}
        />
        <span className="text-xs text-muted-foreground">
          At least 10 characters. Helps the agent decide when this is relevant.
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
          disabled={saving}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save memory"}
        </Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
