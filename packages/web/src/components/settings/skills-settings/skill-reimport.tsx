"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Skill } from "@open-inspect/shared/types/skills";
import { previewSkillReimport, reimportSkill } from "@/hooks/use-managed-skills";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkillImportReview, SkillImportSourceSummary } from "./skill-import-review";
import { errorMessage, previewedSourceConfirmation } from "./utils";
import { useImportPreview } from "./use-import-preview";

/**
 * Pull the recorded source again as a new revision. Only the ref moves: the
 * repository and subdirectory come from what was recorded, and there is no
 * background sync — the update happens when someone asks for it.
 */
export function SkillReimport({
  skill,
  dirty,
  onReimported,
  onSavingChange,
}: {
  skill: Skill;
  /** Whether the surrounding editor holds unsaved changes this would discard. */
  dirty: boolean;
  onReimported: () => void | Promise<void>;
  onSavingChange: (saving: boolean) => void;
}) {
  const source = skill.source;
  const [ref, setRef] = useState("");
  const [saving, setSaving] = useState(false);
  const {
    preview,
    loading: loadingPreview,
    run: runPreview,
    invalidate: invalidatePreview,
  } = useImportPreview(() => previewSkillReimport(skill.id, ref.trim() || null));

  if (!source) return null;
  const unchanged = preview !== null && preview.revisionSha256 === skill.revisionSha256;

  async function confirm() {
    if (!preview) return;
    // A new revision remounts the editor, so unsaved edits would vanish
    // without a word. Same guard the editor's Close button uses.
    if (
      dirty &&
      !window.confirm("Discard your unsaved changes and replace them with the source's content?")
    ) {
      return;
    }
    setSaving(true);
    onSavingChange(true);
    try {
      const result = await reimportSkill(skill.id, skill.currentRevisionId, {
        ref: ref.trim() || null,
        ...previewedSourceConfirmation(preview),
      });
      toast.success(
        result.revisionCreated
          ? `Saved revision ${result.skill.revisionNumber} from ${preview.source.commitSha.slice(0, 7)}`
          : "Source content is unchanged; no revision added"
      );
      invalidatePreview();
      await onReimported();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  }

  return (
    <div className="space-y-4 rounded border border-border-muted p-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">Imported source</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Re-import replaces this skill&apos;s content with the source&apos;s. Assignments, the
          canonical name, and existing sessions are untouched.
        </p>
        <div className="mt-3">
          <SkillImportSourceSummary source={source} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <Label htmlFor="reimport-ref">Branch, tag, or commit (optional)</Label>
          <Input
            id="reimport-ref"
            value={ref}
            onChange={(event) => {
              setRef(event.target.value);
              invalidatePreview();
            }}
            placeholder={source.requestedRef ?? "default branch"}
            className="mt-1 font-mono"
          />
        </div>
        <Button variant="subtle" onClick={runPreview} disabled={loadingPreview || saving}>
          {loadingPreview ? "Reading..." : preview ? "Refresh preview" : "Check for updates"}
        </Button>
      </div>
      {preview &&
        (unchanged ? (
          <p className="rounded bg-muted/50 p-3 text-xs text-muted-foreground">
            {preview.source.commitSha.slice(0, 7)} produces the same content as revision{" "}
            {skill.revisionNumber}. Nothing to import.
          </p>
        ) : (
          <>
            <SkillImportReview preview={preview} />
            <div className="flex justify-end">
              <Button onClick={confirm} disabled={saving}>
                {saving ? "Importing..." : "Save new revision from source"}
              </Button>
            </div>
          </>
        ))}
    </div>
  );
}
