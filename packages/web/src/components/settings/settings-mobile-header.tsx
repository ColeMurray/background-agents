"use client";

import type { RefObject } from "react";
import Link from "next/link";
import { BackIcon, XIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";

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
  const actionClassName = "h-11 w-11 rounded-md";

  return (
    <header className="grid h-14 shrink-0 grid-cols-[2.75rem_1fr_2.75rem] items-center border-b border-border-muted px-3">
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBack}
          className={actionClassName}
          aria-label="Back to settings"
        >
          <span aria-hidden="true">
            <BackIcon className="h-4 w-4" />
          </span>
        </Button>
      ) : backHref ? (
        <Button asChild variant="ghost" size="icon" className={actionClassName}>
          <Link href={backHref} aria-label="Back to integrations">
            <span aria-hidden="true">
              <BackIcon className="h-4 w-4" />
            </span>
          </Link>
        </Button>
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
      <Button asChild variant="ghost" size="icon" className={actionClassName}>
        <Link href="/" aria-label="Close settings">
          <span aria-hidden="true">
            <XIcon className="h-4 w-4" />
          </span>
        </Link>
      </Button>
    </header>
  );
}
