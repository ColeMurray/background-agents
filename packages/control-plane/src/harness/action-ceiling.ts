export const HARNESS_ACTION_CEILING = 512;

/**
 * The ceiling on what one turn may do.
 *
 * A harness with no sandbox has no wall: the only thing that bounds the agent
 * is a count. The count is a **ceiling**, not a budget — it says how much a
 * single turn may do before the harness stops it, whatever the budget says.
 *
 * The budget is the deployment's policy about money; the ceiling is the
 * product's policy about a runaway turn. Both are checked, and the stricter
 * one wins.
 */
export interface HarnessActionCeiling {
  /** How many actions the turn may still take. */
  remaining(): number;
  /** Take one action's worth of the budget. */
  consume(): void;
}

/**
 * A ceiling that never runs out, for a runtime that does not want one.
 */
export const UNLIMITED_ACTION_CEILING: HarnessActionCeiling = {
  remaining: () => Number.POSITIVE_INFINITY,
  consume: () => undefined,
};

/**
 * A ceiling of a fixed number of actions.
 */
export function createFixedActionCeiling(limit: number): HarnessActionCeiling {
  let remaining = Math.max(0, limit);
  return {
    remaining: () => remaining,
    consume: () => {
      remaining = Math.max(0, remaining - 1);
    },
  };
}
