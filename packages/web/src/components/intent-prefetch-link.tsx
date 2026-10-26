"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";

export function IntentPrefetchLink(props: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [intent, setIntent] = useState(false);

  // First intent enables viewport observation, so prefetch starts at default priority;
  // later hover/touch events use Next's intent priority. We accept the first-intent
  // delay to avoid speculative prefetches for every visible session.
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onMouseEnter={(event) => {
        setIntent(true);
        props.onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        setIntent(true);
        props.onFocus?.(event);
      }}
      onTouchStart={(event) => {
        setIntent(true);
        props.onTouchStart?.(event);
      }}
    />
  );
}
