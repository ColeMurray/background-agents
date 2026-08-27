"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import type { SkillImportPreviewResponse } from "@open-inspect/shared/types/skills";
import { errorMessage } from "./utils";

/** Own the race-safe lifecycle shared by import and re-import previews. */
export function useImportPreview(loadPreview: () => Promise<SkillImportPreviewResponse>) {
  const [preview, setPreview] = useState<SkillImportPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);

  async function run(): Promise<SkillImportPreviewResponse | null> {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const result = await loadPreview();
      if (version !== requestVersion.current) return null;
      setPreview(result);
      return result;
    } catch (error) {
      if (version !== requestVersion.current) return null;
      setPreview(null);
      toast.error(errorMessage(error));
      return null;
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  function invalidate(): void {
    requestVersion.current += 1;
    setLoading(false);
    setPreview(null);
  }

  return { preview, loading, run, invalidate };
}
