"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";

export function IntentPrefetchLink(props: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [intent, setIntent] = useState(false);

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
