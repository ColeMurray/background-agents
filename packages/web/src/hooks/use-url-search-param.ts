"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search";

/**
 * A search box mirrored in one URL query parameter, so a filtered view can be shared or reloaded.
 *
 * The URL is the source of truth for the applied search (`value`). Typed text is written to the
 * URL after SEARCH_DEBOUNCE_MS, through `commit`, which maps text to the value to write ("" removes
 * the parameter) or to null when the text should not be written at all.
 *
 * A write takes a moment to show up in the URL, so the hook tracks the value it last wrote rather
 * than comparing against the rendered URL (as the sessions page does):
 * - When the URL reaches the value we wrote, the box keeps the text as typed (a trailing space, or
 *   a one-letter edit that commits to no search). An earlier write landing late is ignored.
 * - A later edit is written even if the URL has not caught up, so reversing a change before the
 *   previous write lands is not lost.
 * - Any URL change while nothing of ours is in flight is navigation (a link, back/forward) and
 *   replaces the box, including text not yet written. Navigation that lands while a write is in
 *   flight is overtaken by that write.
 */
export function useUrlSearchParam(name: string, commit: (raw: string) => string | null) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(name) ?? "";
  const [text, setTextState] = useState(value);
  // Text typed since the URL last matched the box; null when there is none.
  const pending = useRef<string | null>(null);
  // The value we wrote and have not yet seen in the URL; null when no write is in flight.
  const inFlight = useRef<string | null>(null);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  useEffect(() => {
    if (inFlight.current !== null) {
      if (value !== inFlight.current) return; // an earlier write of ours landing late
      inFlight.current = null;
      if (pending.current !== null && commitRef.current(pending.current) === value) {
        pending.current = null; // the typed text is applied; keep it as typed
      }
      return;
    }
    pending.current = null;
    setTextState(value);
  }, [value]);

  useEffect(() => {
    const typed = pending.current;
    if (typed === null) return;
    const target = commitRef.current(typed);
    if (target === null) return;
    const timeout = window.setTimeout(() => {
      const expected = inFlight.current ?? params.get(name) ?? "";
      if (target === expected) {
        if (inFlight.current === null) pending.current = null;
        return;
      }
      const query = new URLSearchParams(params.toString());
      if (target) query.set(name, target);
      else query.delete(name);
      const queryString = query.toString();
      inFlight.current = target;
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [text, name, params, pathname, router]);

  const setText = useCallback((next: string) => {
    pending.current = next;
    setTextState(next);
  }, []);

  return {
    /** The box's text, including anything not yet written to the URL. */
    text,
    setText,
    /** The parameter's current URL value. */
    value,
  };
}
