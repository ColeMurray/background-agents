"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { CheckIcon } from "@/components/ui/icons";

export interface ComboboxOption<T = string> {
  value: T;
  label: string;
  description?: string;
}

export interface ComboboxGroup<T = string> {
  category: string;
  options: ComboboxOption<T>[];
}

function isGrouped<T>(
  items: ComboboxOption<T>[] | ComboboxGroup<T>[]
): items is ComboboxGroup<T>[] {
  return items.length > 0 && "category" in items[0];
}

interface ComboboxProps<T = string> {
  value: T;
  onChange: (value: T) => void;
  items: ComboboxOption<T>[] | ComboboxGroup<T>[];
  children: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  filterFn?: (option: ComboboxOption<T>, query: string) => boolean;
  direction?: "up" | "down";
  dropdownWidth?: string;
  prependContent?: (helpers: { select: (value: T) => void }) => ReactNode;
  disabled?: boolean;
  triggerClassName?: string;
}

export function Combobox<T = string>({
  value,
  onChange,
  items,
  children,
  searchable = false,
  searchPlaceholder = "Search...",
  filterFn,
  direction = "down",
  dropdownWidth = "w-56",
  prependContent,
  disabled = false,
  triggerClassName = "",
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    if (searchable) {
      const id = requestAnimationFrame(() => searchInputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open, searchable]);

  const handleSelect = (optionValue: T) => {
    onChange(optionValue);
    setOpen(false);
  };

  const normalizedQuery = query.trim().toLowerCase();

  const defaultFilter = (option: ComboboxOption<T>, q: string) =>
    option.label.toLowerCase().includes(q) ||
    (option.description?.toLowerCase().includes(q) ?? false);

  const filterOption = filterFn || defaultFilter;

  const filteredItems = (() => {
    if (!normalizedQuery) return items;

    if (isGrouped(items)) {
      return items
        .map((group) => ({
          ...group,
          options: group.options.filter((opt) => filterOption(opt, normalizedQuery)),
        }))
        .filter((group) => group.options.length > 0);
    }

    return items.filter((opt) => filterOption(opt, normalizedQuery));
  })();

  const hasResults = isGrouped(filteredItems)
    ? filteredItems.some((g) => g.options.length > 0)
    : filteredItems.length > 0;

  const directionClasses = direction === "up" ? "bottom-full mb-2" : "top-full mt-1";

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={triggerClassName}
      >
        {children}
      </button>

      {open && (
        <div
          className={`absolute ${directionClasses} left-0 ${dropdownWidth} bg-background shadow-lg border border-border z-50`}
        >
          {searchable && (
            <div className="p-2 border-b border-border-muted">
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
                placeholder={searchPlaceholder}
                className="w-full px-2 py-1.5 text-sm bg-input border border-border focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent placeholder:text-secondary-foreground text-foreground"
              />
            </div>
          )}

          <div className="max-h-56 overflow-y-auto py-1">
            {prependContent?.({ select: handleSelect })}

            {!hasResults && normalizedQuery ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No results match {query.trim()}
              </div>
            ) : isGrouped(filteredItems) ? (
              filteredItems.map((group, groupIdx) => (
                <div key={group.category}>
                  <div
                    className={`px-3 py-1.5 text-xs font-medium text-secondary-foreground uppercase tracking-wider ${
                      groupIdx > 0 ? "border-t border-border-muted mt-1" : ""
                    }`}
                  >
                    {group.category}
                  </div>
                  {group.options.map((option) => (
                    <OptionButton
                      key={String(option.value)}
                      option={option}
                      isSelected={option.value === value}
                      onSelect={() => handleSelect(option.value)}
                    />
                  ))}
                </div>
              ))
            ) : (
              (filteredItems as ComboboxOption<T>[]).map((option) => (
                <OptionButton
                  key={String(option.value)}
                  option={option}
                  isSelected={option.value === value}
                  onSelect={() => handleSelect(option.value)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionButton<T>({
  option,
  isSelected,
  onSelect,
}: {
  option: ComboboxOption<T>;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
        isSelected ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      <div className="flex flex-col items-start text-left min-w-0">
        <span className="font-medium truncate max-w-full">{option.label}</span>
        {option.description && (
          <span className="text-xs text-secondary-foreground truncate max-w-full">
            {option.description}
          </span>
        )}
      </div>
      {isSelected && <CheckIcon className="w-4 h-4 text-accent flex-shrink-0" />}
    </button>
  );
}
