interface DanstackLogoProps {
  className?: string;
  title?: string;
}

export function DanstackLogo({ className, title = "Danstack AI" }: DanstackLogoProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 800 200"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>

      <g
        style={{
          fontFamily:
            '"Geist Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontWeight: 800,
          letterSpacing: "-0.035em",
        }}
      >
        {/* Layered treatment for the "Danstack" mark inspired by LazyVim's stacked outline look. */}
        <text
          x="22"
          y="156"
          fontSize="118"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="8"
          opacity="0.28"
        >
          Danstack
        </text>
        <text
          x="14"
          y="148"
          fontSize="118"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="4"
          opacity="0.48"
        >
          Danstack
        </text>
        <text x="8" y="142" fontSize="118" fill="var(--accent)">
          Danstack
        </text>
      </g>

      <g
        style={{
          fontFamily:
            '"Geist Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontWeight: 700,
          letterSpacing: "-0.02em",
        }}
      >
        {/* Cleaner secondary mark for "AI" inspired by OpenCode's geometric block style. */}
        <text x="640" y="146" fontSize="98" fill="var(--foreground)">
          AI
        </text>
      </g>
    </svg>
  );
}
