"use client";

import { useState, useRef, useEffect, useCallback, useId, type ReactNode } from "react";
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

function flattenOptions<T>(items: ComboboxOption<T>[] | ComboboxGroup<T>[]): ComboboxOption<T>[] {
  if (isGrouped(items)) {
    return items.flatMap((group) => group.options);
  }
  return items;
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
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const instanceId = useId();
  const listboxId = `${instanceId}-listbox`;
  const optionIdPrefix = `${instanceId}-option`;

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
      setActiveIndex(-1);
      return;
    }
    if (searchable) {
      const id = requestAnimationFrame(() => searchInputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open, searchable]);

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

  const flatOptions = flattenOptions(filteredItems);

  const hasResults = flatOptions.length > 0;

  // Reset active index when filtered results change (e.g. typing in search)
  useEffect(() => {
    if (open && flatOptions.length > 0) {
      setActiveIndex(0);
    } else {
      setActiveIndex(-1);
    }
    // Use normalizedQuery as dependency instead of flatOptions to avoid reference issues
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedQuery, open]);

  // Set initial active index to the selected value when opening
  useEffect(() => {
    if (!open) return;
    const selectedIdx = flatOptions.findIndex((opt) => opt.value === value);
    if (selectedIdx >= 0) {
      setActiveIndex(selectedIdx);
    }
    // Only run when dropdown opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Scroll active option into view
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const activeEl = listRef.current.querySelector(`[data-option-index="${activeIndex}"]`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleSelect = useCallback(
    (optionValue: T) => {
      onChange(optionValue);
      setOpen(false);
    },
    [onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          if (flatOptions.length === 0) return;
          setActiveIndex((prev) => (prev + 1) % flatOptions.length);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (flatOptions.length === 0) return;
          setActiveIndex((prev) => (prev <= 0 ? flatOptions.length - 1 : prev - 1));
          break;
        }
        case "Home": {
          e.preventDefault();
          if (flatOptions.length > 0) setActiveIndex(0);
          break;
        }
        case "End": {
          e.preventDefault();
          if (flatOptions.length > 0) setActiveIndex(flatOptions.length - 1);
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < flatOptions.length) {
            handleSelect(flatOptions[activeIndex].value);
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          setOpen(false);
          break;
        }
        case "Tab": {
          setOpen(false);
          break;
        }
      }
    },
    [open, flatOptions, activeIndex, handleSelect]
  );

  const directionClasses = direction === "up" ? "bottom-full mb-2" : "top-full mt-1";

  const activeOptionId = activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : undefined;

  return (
    <div className="relative" ref={containerRef} onKeyDown={handleKeyDown}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={triggerClassName}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open ? activeOptionId : undefined}
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
                placeholder={searchPlaceholder}
                className="w-full px-2 py-1.5 text-sm bg-input border border-border focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent placeholder:text-secondary-foreground text-foreground"
                role="combobox"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
              />
            </div>
          )}

          <div
            ref={listRef}
            className="max-h-56 overflow-y-auto py-1"
            role="listbox"
            id={listboxId}
          >
            {prependContent?.({ select: handleSelect })}

            {!hasResults && normalizedQuery ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No results match {query.trim()}
              </div>
            ) : isGrouped(filteredItems) ? (
              filteredItems.map((group, groupIdx) => {
                const groupOffset = filteredItems
                  .slice(0, groupIdx)
                  .reduce((sum, g) => sum + g.options.length, 0);
                return (
                  <div key={group.category} role="group" aria-label={group.category}>
                    <div
                      className={`px-3 py-1.5 text-xs font-medium text-secondary-foreground uppercase tracking-wider ${
                        groupIdx > 0 ? "border-t border-border-muted mt-1" : ""
                      }`}
                    >
                      {group.category}
                    </div>
                    {group.options.map((option, optIdx) => {
                      const idx = groupOffset + optIdx;
                      return (
                        <OptionButton
                          key={String(option.value)}
                          option={option}
                          isSelected={option.value === value}
                          isActive={idx === activeIndex}
                          onSelect={() => handleSelect(option.value)}
                          onMouseEnter={() => setActiveIndex(idx)}
                          id={`${optionIdPrefix}-${idx}`}
                          dataIndex={idx}
                        />
                      );
                    })}
                  </div>
                );
              })
            ) : (
              (filteredItems as ComboboxOption<T>[]).map((option, idx) => (
                <OptionButton
                  key={String(option.value)}
                  option={option}
                  isSelected={option.value === value}
                  isActive={idx === activeIndex}
                  onSelect={() => handleSelect(option.value)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  id={`${optionIdPrefix}-${idx}`}
                  dataIndex={idx}
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
  isActive,
  onSelect,
  onMouseEnter,
  id,
  dataIndex,
}: {
  option: ComboboxOption<T>;
  isSelected: boolean;
  isActive: boolean;
  onSelect: () => void;
  onMouseEnter: () => void;
  id: string;
  dataIndex: number;
}) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      data-option-index={dataIndex}
      className={`w-full flex items-center justify-between px-3 py-2 text-sm transition ${
        isActive ? "bg-muted" : ""
      } ${isSelected ? "text-foreground" : "text-muted-foreground"}`}
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
