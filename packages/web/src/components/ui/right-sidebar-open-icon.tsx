interface IconProps {
  className?: string;
}

/** Distinct from RightSidebarIcon: filled right rail when the details sidebar is open. */
export function RightSidebarOpenIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      data-testid="right-sidebar-icon-open"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
      <rect x="15" y="3" width="6" height="18" fill="currentColor" stroke="none" />
    </svg>
  );
}
