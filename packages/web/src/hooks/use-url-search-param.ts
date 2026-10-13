"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search";

/**
 * A search box mirrored in one URL query parameter, so a filtered view can be shared or reloaded.
 *
 * The URL is the source of truth for the applied search (`value`). Typed text is written to the
 * URL once the value to write has been stable for SEARCH_DEBOUNCE_MS, through `commit`, which maps
 * text to that value ("" removes the parameter) or to null when the text should not be written.
 *
 * The box remembers which URL value its text accounts for: the last one we wrote or navigated to.
 * When the URL changes and still holds that value (our own write arriving, or another parameter
 * changing), the box keeps the text as typed. Any other change is navigation: it replaces the box
 * and discards text not yet written.
 */
export function useUrlSearchParam(name: string, commit: (raw: string) => string | null) {
  const params = useSearchParams();
  const value = params.get(name) ?? "";
  const [text, setTextState] = useState(value);
  // The URL value the box's text accounts for.
  const [expected, setExpected] = useState(value);
  // What typed text will write once typing pauses; null when nothing is waiting.
  const [draft, setDraft] = useState<string | null>(null);
  // Watch each URL snapshot, not just its value: after a write of ours that never showed up,
  // navigation can return to the exact query last rendered and must still be noticed.
  const [seenParams, setSeenParams] = useState(params);
  if (params !== seenParams) {
    setSeenParams(params);
    if (value !== expected) {
      setTextState(value);
      setExpected(value);
      setDraft(null);
    }
  }

  useEffect(() => {
    if (draft === null) return;
    const timeout = window.setTimeout(() => {
      setExpected(draft);
      setDraft(null);
      writeSearchParam(name, draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [name, draft]);

  function setText(next: string) {
    setTextState(next);
    setDraft(commit(next));
  }

  return {
    /** The box's text, including anything not yet written to the URL. */
    text,
    setText,
    /** The parameter's current URL value. */
    value,
  };
}

// The address bar, not useSearchParams: replaceState updates it synchronously, while
// useSearchParams follows a render later. Never call these during render.

function readSearchParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

/** Sets (or, for "", removes) one parameter, keeping the others, without a server round trip. */
function writeSearchParam(name: string, value: string) {
  if (readSearchParam(name) === value) return;
  const query = new URLSearchParams(window.location.search);
  if (value) query.set(name, value);
  else query.delete(name);
  const queryString = query.toString();
  const { pathname } = window.location;
  window.history.replaceState(
    appHistoryState(),
    "",
    queryString ? `${pathname}?${queryString}` : pathname
  );
}

// Next skips syncing useSearchParams for writes carrying its own keys, and copies them back itself.
const NEXT_HISTORY_KEYS = ["__NA", "_N", "__PRIVATE_NEXTJS_INTERNALS_TREE"];

/** The current entry's app-owned state (e.g. mobile settings' detail flag), without Next's keys. */
function appHistoryState(): Record<string, unknown> | null {
  const state: unknown = window.history.state;
  if (!state || typeof state !== "object") return null;
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => !NEXT_HISTORY_KEYS.includes(key))
  );
}
