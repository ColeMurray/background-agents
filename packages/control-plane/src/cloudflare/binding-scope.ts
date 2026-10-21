/**
 * Narrowing a Durable Object's runtime bindings.
 *
 * A Durable Object is handed the **whole** Worker env at runtime, whatever
 * its TypeScript type says. The type is a promise to the compiler; the object
 * is what the code inside the object can actually reach. When that code
 * includes model-driven code — tools, a script runtime, an extension — the
 * difference is the difference between a guarantee and a habit.
 *
 * So the env is scoped **before** it reaches the base class. The object then
 * holds a bindings object that physically has no key it is not meant to have:
 * the deployment's secrets, its database and its service bindings are not
 * merely inaccessible, they are absent.
 *
 * This is the harness-neutral form of the rule. A Durable Object harness that
 * runs model-driven code in-process uses it; a harness that does not may still
 * use it, because the cost is one line and the benefit is a class of bug that
 * cannot be written.
 */

/** The subset of a binding object an object is allowed to hold. */
export type ScopedBindings<Bindings extends object, Key extends keyof Bindings> = Pick<
  Bindings,
  Key
>;

/**
 * Return a bindings object holding only the named keys.
 *
 * The result is a **new** object. The caller's own bindings are untouched, so
 * scoping one object never removes a binding from another.
 */
export function scopeBindings<Bindings extends object, Key extends keyof Bindings>(
  bindings: Bindings,
  keys: readonly Key[]
): ScopedBindings<Bindings, Key> {
  const scoped: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in bindings)) continue;
    scoped[key as string] = bindings[key];
  }
  return scoped as ScopedBindings<Bindings, Key>;
}

/** The names of the keys a scoped bindings object actually holds. */
export function scopedBindingNames(bindings: object): string[] {
  return Object.keys(bindings).sort();
}
