type LogoMarkProps = {
  className?: string;
  /**
   * Explicit pixel size and color, for renderers that apply no CSS —
   * `next/og` (satori) ignores `className` and cannot resolve `currentColor`.
   */
  size?: number;
  color?: string;
};

/** The OpenInspect mark: a square outline with a smaller filled square inside. */
export function LogoMark({ className, color = "currentColor", size }: LogoMarkProps) {
  return (
    <svg
      aria-hidden
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 36 36"
      width={size}
    >
      <rect height="34" stroke={color} strokeWidth="2" width="34" x="1" y="1" />
      <rect fill={color} height="20" width="20" x="8" y="8" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2.5 font-semibold">
      <LogoMark className="size-6 shrink-0" />
      <span>OpenInspect</span>
    </span>
  );
}
