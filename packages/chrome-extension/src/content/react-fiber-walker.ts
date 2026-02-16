/**
 * react fiber tree walker.
 * accesses react internals to extract a structured component tree
 * from a selected dom element.
 */

import type { ReactComponentNode } from "@/shared/types";

// minimal react fiber type for traversal
interface FiberNode {
  type: unknown;
  return: FiberNode | null;
  child: FiberNode | null;
  sibling: FiberNode | null;
  memoizedProps: Record<string, unknown> | null;
  stateNode: unknown;
  tag: number;
}

// react fiber tags we care about
const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const HOST_COMPONENT = 5; // dom element
const FORWARD_REF = 11;
const MEMO_COMPONENT = 14;
const SIMPLE_MEMO = 15;

const COMPONENT_TAGS = new Set([
  FUNCTION_COMPONENT,
  CLASS_COMPONENT,
  FORWARD_REF,
  MEMO_COMPONENT,
  SIMPLE_MEMO,
]);

const MAX_DEPTH = 8;
const MAX_CHILDREN = 15;
const MAX_PROP_VALUE_LEN = 100;

/**
 * attempt to extract a react component tree from a dom element.
 * returns null if no react fiber is found.
 */
export function getReactTree(element: Element): ReactComponentNode | null {
  const fiber = findFiber(element);
  if (!fiber) return null;

  // walk up to find the nearest named component ancestor
  const rootFiber = findNearestComponentFiber(fiber);
  if (!rootFiber) return null;

  return serializeFiber(rootFiber, 0);
}

/**
 * find the react fiber attached to a dom element.
 */
function findFiber(element: Element): FiberNode | null {
  const key = Object.keys(element).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
  );
  if (!key) return null;

  // cast: react attaches fiber nodes as expando properties on dom elements at runtime.
  // there is no typed api for this - validated by the key prefix check above.
  const elRecord = element as unknown as Record<string, unknown>;
  return elRecord[key] as FiberNode;
}

/**
 * walk up the fiber tree to find the nearest named component.
 */
function findNearestComponentFiber(fiber: FiberNode): FiberNode | null {
  let current: FiberNode | null = fiber;
  let depth = 0;

  while (current && depth < 20) {
    if (COMPONENT_TAGS.has(current.tag) && getComponentName(current)) {
      return current;
    }
    current = current.return;
    depth++;
  }

  return null;
}

/**
 * serialize a fiber node into a structured tree.
 */
function serializeFiber(fiber: FiberNode, depth: number): ReactComponentNode | null {
  if (depth > MAX_DEPTH) return null;

  const name = getComponentName(fiber);
  if (!name) return null;

  const props = serializeProps(fiber.memoizedProps);
  const children: ReactComponentNode[] = [];

  // walk child fibers
  let child = fiber.child;
  let count = 0;

  while (child && count < MAX_CHILDREN) {
    if (COMPONENT_TAGS.has(child.tag)) {
      const serialized = serializeFiber(child, depth + 1);
      if (serialized) {
        children.push(serialized);
        count++;
      }
    } else if (child.tag === HOST_COMPONENT) {
      // for dom elements, look inside them for component children
      const nested = collectComponentChildren(child, depth + 1, MAX_CHILDREN - count);
      children.push(...nested);
      count += nested.length;
    }

    child = child.sibling;
  }

  return { name, props, children };
}

/**
 * collect component children inside a host (dom) fiber.
 */
function collectComponentChildren(
  fiber: FiberNode,
  depth: number,
  maxCount: number
): ReactComponentNode[] {
  if (depth > MAX_DEPTH || maxCount <= 0) return [];

  const results: ReactComponentNode[] = [];
  let child = fiber.child;

  while (child && results.length < maxCount) {
    if (COMPONENT_TAGS.has(child.tag)) {
      const serialized = serializeFiber(child, depth);
      if (serialized) results.push(serialized);
    } else if (child.tag === HOST_COMPONENT) {
      const nested = collectComponentChildren(child, depth, maxCount - results.length);
      results.push(...nested);
    }
    child = child.sibling;
  }

  return results;
}

/**
 * extract the display name of a component from its fiber.
 */
function getComponentName(fiber: FiberNode): string | null {
  const type = fiber.type;
  if (!type) return null;

  if (typeof type === "function") {
    // cast: function.displayName and function.name are standard js
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || null;
  }

  if (typeof type === "object" && type !== null) {
    // forward ref / memo wrapping
    const wrapped = type as { displayName?: string; render?: { displayName?: string; name?: string } };
    if (wrapped.displayName) return wrapped.displayName;
    if (wrapped.render) {
      return wrapped.render.displayName || wrapped.render.name || null;
    }
  }

  if (typeof type === "string") {
    return type; // host component tag name
  }

  return null;
}

/**
 * serialize component props into a flat string map.
 * filters out children, internal props, and truncates long values.
 */
function serializeProps(props: Record<string, unknown> | null): Record<string, string> {
  if (!props) return {};

  const result: Record<string, string> = {};
  const skipKeys = new Set(["children", "ref", "key", "__self", "__source"]);
  let count = 0;

  for (const [key, value] of Object.entries(props)) {
    if (skipKeys.has(key) || key.startsWith("__")) continue;
    if (count >= 10) break; // limit props shown

    const serialized = serializePropValue(value);
    if (serialized !== null) {
      result[key] = serialized;
      count++;
    }
  }

  return result;
}

function serializePropValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return truncate(value, MAX_PROP_VALUE_LEN);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "[function]";
  if (Array.isArray(value)) return `[array(${value.length})]`;
  if (typeof value === "object") return "[object]";
  return null;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}
