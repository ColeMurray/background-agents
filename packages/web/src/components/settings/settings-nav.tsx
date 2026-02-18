"use client";

const NAV_ITEMS = [
  {
    id: "secrets",
    label: "Secrets",
    icon: KeyIcon,
  },
  {
    id: "models",
    label: "Models",
    icon: ModelsIcon,
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard",
    icon: KeyboardIcon,
  },
  {
    id: "data-controls",
    label: "Data Controls",
    icon: DataControlsIcon,
  },
] as const;

export type SettingsCategory = (typeof NAV_ITEMS)[number]["id"];

interface SettingsNavProps {
  activeCategory: SettingsCategory;
  onSelect: (category: SettingsCategory) => void;
}

export function SettingsNav({ activeCategory, onSelect }: SettingsNavProps) {
  return (
    <nav className="w-48 flex-shrink-0 border-r border-border-muted p-4">
      <h2 className="text-lg font-semibold text-foreground mb-4">Settings</h2>
      <ul className="space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = activeCategory === item.id;
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                onClick={() => onSelect(item.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded transition ${
                  isActive
                    ? "text-foreground bg-muted font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <Icon />
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function DataControlsIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function ModelsIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h8M16 14h2" />
    </svg>
  );
}
