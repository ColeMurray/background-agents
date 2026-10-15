"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "./utils";

/** Own the race-safe lifecycle shared by import and re-import previews. */
export function useImportPreview<T>(
  loadPreview: () => Promise<T>,
  onLoadingChange?: (loading: boolean) => void,
  onSuccess?: (result: T) => void
) {
  const [preview, setPreview] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);
  const requestActive = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
      requestActive.current = false;
    };
  }, []);

  async function run(): Promise<T | null> {
    if (requestActive.current) return null;
    requestActive.current = true;
    const version = ++requestVersion.current;
    setLoading(true);
    onLoadingChange?.(true);
    try {
      const result = await loadPreview();
      if (!mounted.current || version !== requestVersion.current) return null;
      onSuccess?.(result);
      setPreview(result);
      return result;
    } catch (error) {
      if (!mounted.current || version !== requestVersion.current) return null;
      setPreview(null);
      toast.error(errorMessage(error));
      return null;
    } finally {
      if (mounted.current && version === requestVersion.current) {
        requestActive.current = false;
        setLoading(false);
        onLoadingChange?.(false);
      }
    }
  }

  function invalidate(): void {
    requestVersion.current += 1;
    requestActive.current = false;
    setLoading(false);
    onLoadingChange?.(false);
    setPreview(null);
  }

  return { preview, loading, run, invalidate };
}
