"use client";

import type { RefObject } from "react";
import Link from "next/link";
import { BackIcon, XIcon } from "@/components/ui/icons";

type SettingsMobileHeaderProps = {
  title: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  backHref?: string;
  onBack?: () => void;
};

export function SettingsMobileHeader({
  title,
  headingRef,
  backHref,
  onBack,
}: SettingsMobileHeaderProps) {
  const backClassName =
    "flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground";

  return (
    <header className="grid h-14 shrink-0 grid-cols-[2.5rem_1fr_2.5rem] items-center border-b border-border-muted px-3">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className={backClassName}
          aria-label="Back to settings"
        >
          <BackIcon className="h-4 w-4" />
        </button>
      ) : backHref ? (
        <Link href={backHref} className={backClassName} aria-label="Back to integrations">
          <BackIcon className="h-4 w-4" />
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      <h1
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        className="truncate px-2 text-center text-sm font-medium text-foreground outline-none"
      >
        {title}
      </h1>
      <Link
        href="/"
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
        aria-label="Close settings"
      >
        <XIcon className="h-4 w-4" />
      </Link>
    </header>
  );
}
