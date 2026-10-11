"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** How long a search box waits after the last keystroke before writing the URL. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * A search box mirrored in one URL query parameter, so a filtered view can be shared or reloaded.
 *
 * The URL is the source of truth for the applied search (`value`). Text typed but not yet in the
 * URL is pending: it is written after SEARCH_DEBOUNCE_MS, and when the URL then shows what that
 * text commits to, the box keeps the text as typed (a trailing space, or a one-letter edit that
 * commits to no search). Any other URL change is navigation (a link, back/forward) and replaces
 * the box, as on the sessions page.
 *
 * `commit` maps typed text to the value to write ("" removes the parameter), or null when the text
 * should not be written at all. Pass a stable function.
 */
export function useUrlSearchParam(name: string, commit: (raw: string) => string | null) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(name) ?? "";
  const [input, setInput] = useState(value);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    const typed = pending.current;
    const target = typed === null ? null : commit(typed);
    if (target === value) {
      // Our own write landed; keep the box as typed.
      pending.current = null;
    } else if (typed === null || target === null) {
      // Nothing of ours is on its way to the URL, so this change is navigation.
      pending.current = null;
      setInput(value);
    }
    // Otherwise an earlier keystroke's write landed while newer text waits to be written.
  }, [commit, value]);

  useEffect(() => {
    const typed = pending.current;
    if (typed === null) return;
    const target = commit(typed);
    if (target === null) return;
    const timeout = window.setTimeout(() => {
      const query = new URLSearchParams(params.toString());
      if (target) query.set(name, target);
      else query.delete(name);
      if (query.toString() === params.toString()) {
        pending.current = null;
        return;
      }
      const queryString = query.toString();
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [commit, input, name, params, pathname, router]);

  return {
    /** The box's text, including anything not yet written to the URL. */
    input,
    setInput(next: string) {
      pending.current = next;
      setInput(next);
    },
    /** The parameter's current URL value. */
    value,
  };
}
