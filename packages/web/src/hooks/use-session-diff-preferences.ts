"use client";

import { useEffect, useState } from "react";

export type DiffStyle = "unified" | "split";

const STYLE_KEY = "session-changes.diff-style";
const WRAP_KEY = "session-changes.wrap";

export function useSessionDiffPreferences() {
  const [diffStyle, setDiffStyleState] = useState<DiffStyle>("unified");
  const [wrap, setWrapState] = useState(false);

  useEffect(() => {
    try {
      const storedStyle = localStorage.getItem(STYLE_KEY);
      if (storedStyle === "unified" || storedStyle === "split") setDiffStyleState(storedStyle);
      setWrapState(localStorage.getItem(WRAP_KEY) === "true");
    } catch {
      // Storage is optional; defaults remain usable in restricted browsers.
    }
  }, []);

  const setDiffStyle = (value: DiffStyle) => {
    setDiffStyleState(value);
    try {
      localStorage.setItem(STYLE_KEY, value);
    } catch {
      // Continue with the in-memory preference when storage is unavailable.
    }
  };
  const setWrap = (value: boolean) => {
    setWrapState(value);
    try {
      localStorage.setItem(WRAP_KEY, String(value));
    } catch {
      // Continue with the in-memory preference when storage is unavailable.
    }
  };
  return { diffStyle, setDiffStyle, wrap, setWrap };
}
