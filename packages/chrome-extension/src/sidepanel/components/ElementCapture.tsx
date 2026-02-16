import { Button } from "@/components/ui/button";
import type { CapturedElement } from "@/shared/types";

interface ElementCaptureProps {
  element: CapturedElement;
  onRemove: () => void;
}

export function ElementCapture({ element, onRemove }: ElementCaptureProps) {
  const displayName = element.reactTree?.name || `<${element.tagName}>`;

  return (
    <div className="mx-4 mb-2 px-3 py-2 bg-sky-50 border border-sky-200 rounded-lg">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <ElementIcon />
          <div className="min-w-0">
            <p className="text-xs font-medium text-sky-800 truncate">{displayName}</p>
            <p className="text-[10px] text-sky-600 truncate">{element.selector}</p>
          </div>
        </div>
        <Button variant="ghost" size="xs" onClick={onRemove} className="flex-shrink-0">
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

function ElementIcon() {
  return (
    <svg
      className="w-4 h-4 text-sky-500 flex-shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
