import { useState } from "react";
import { MEMORY_ACTIONS, type MemoryDto } from "@open-inspect/shared/types/memories";

/**
 * Records chosen for a bulk action in one view (status, page and search). Only records with a
 * granted action can be chosen; changing the view starts a new, empty selection, and records that
 * leave the page leave the selection. State is adjusted during render, not in an effect.
 */
export function useMemorySelection(records: readonly MemoryDto[], view: string) {
  const [state, setState] = useState({ view, ids: new Set<string>() });
  if (state.view !== view) setState({ view, ids: new Set() });
  const ids = state.view === view ? state.ids : new Set<string>();
  const selectable = records.filter((record) => record.capabilities.actions.length > 0);
  const selected = selectable.filter((record) => ids.has(record.id));
  const select = (next: Iterable<string>) => setState({ view, ids: new Set(next) });
  return {
    selectable,
    selected,
    /** This exact selection in this view; changes whenever a record joins or leaves it. */
    key: `${view}|${selected.map((record) => record.id).join(",")}`,
    /** Actions every selected record allows, in lifecycle order. */
    actions: selected.length
      ? MEMORY_ACTIONS.filter((action) =>
          selected.every((record) => record.capabilities.actions.includes(action))
        )
      : [],
    isSelected: (id: string) => ids.has(id),
    toggle(id: string, checked: boolean) {
      const next = new Set(ids);
      if (checked) next.add(id);
      else next.delete(id);
      select(next);
    },
    toggleAll(checked: boolean) {
      select(checked ? selectable.map((record) => record.id) : []);
    },
    clear() {
      select([]);
    },
  };
}

export type MemorySelection = ReturnType<typeof useMemorySelection>;
