"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import type { Skill, SkillImportPreviewResponse } from "@open-inspect/shared/types/skills";
import { previewSkillReimport, reimportSkill } from "@/hooks/use-managed-skills";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkillImportReview, SkillImportSourceSummary } from "./skill-import-review";
import { errorMessage, previewedSourceConfirmation } from "./utils";

/**
 * Pull the recorded source again as a new revision. Only the ref moves: the
 * repository and subdirectory come from what was recorded, and there is no
 * background sync — the update happens when someone asks for it.
 */
export function SkillReimport({
  skill,
  dirty,
  onReimported,
}: {
  skill: Skill;
  /** Whether the surrounding editor holds unsaved changes this would discard. */
  dirty: boolean;
  onReimported: () => void;
}) {
  const source = skill.source;
  const [ref, setRef] = useState("");
  const [preview, setPreview] = useState<SkillImportPreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const previewRequestVersion = useRef(0);

  if (!source) return null;
  const unchanged = preview !== null && preview.revisionSha256 === skill.revisionSha256;

  async function runPreview() {
    const requestVersion = ++previewRequestVersion.current;
    setLoadingPreview(true);
    try {
      const result = await previewSkillReimport(skill.id, ref.trim() || null);
      if (requestVersion === previewRequestVersion.current) setPreview(result);
    } catch (error) {
      if (requestVersion !== previewRequestVersion.current) return;
      setPreview(null);
      toast.error(errorMessage(error));
    } finally {
      if (requestVersion === previewRequestVersion.current) setLoadingPreview(false);
    }
  }

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
      setPreview(null);
      onReimported();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
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
              previewRequestVersion.current += 1;
              setRef(event.target.value);
              setLoadingPreview(false);
              setPreview(null);
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
