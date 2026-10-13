"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search";

/**
 * A search box mirrored in one URL query parameter, so a filtered view can be shared or reloaded.
 *
 * The URL is the source of truth for the applied search (`value`). Typed text is written to the
 * URL SEARCH_DEBOUNCE_MS after the last keystroke, through `commit`, which maps text to the value
 * to write ("" removes the parameter) or to null when the text should not be written at all.
 *
 * The box remembers which URL value its text accounts for. When the URL changes to that value
 * (our own write arriving), the box keeps the text as typed; any other change is navigation and
 * replaces the box, unless a keystroke is still waiting to be written over it.
 */
export function useUrlSearchParam(name: string, commit: (raw: string) => string | null) {
  const value = useSearchParams().get(name) ?? "";
  const [text, setTextState] = useState(value);
  // The URL value the box's text accounts for; null while a keystroke waits to be written.
  const [expected, setExpected] = useState<string | null>(value);
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    if (expected !== null && value !== expected) {
      setTextState(value);
      setExpected(value);
    }
  }

  const debounce = useDebounce(SEARCH_DEBOUNCE_MS);

  function setText(next: string) {
    setTextState(next);
    const target = commit(next);
    if (target === null) {
      // Nothing to write: the box now accounts for the URL as it stands.
      debounce.cancel();
      setExpected(readSearchParam(name));
      return;
    }
    setExpected(null);
    debounce.run(() => {
      setExpected(target);
      writeSearchParam(name, target);
    });
  }

  return {
    /** The box's text, including anything not yet written to the URL. */
    text,
    setText,
    /** The parameter's current URL value. */
    value,
  };
}

/** Runs the latest scheduled callback once `delayMs` passes without another; cleared on unmount. */
function useDebounce(delayMs: number) {
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    run(callback: () => void) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(callback, delayMs);
    },
    cancel() {
      window.clearTimeout(timer.current);
    },
  };
}

// The address bar, not useSearchParams: replaceState updates it synchronously, while
// useSearchParams follows a render later. Call these from event handlers, never during render.

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
  // Next syncs useSearchParams with native history calls whose state is not its own.
  window.history.replaceState(null, "", queryString ? `${pathname}?${queryString}` : pathname);
}
