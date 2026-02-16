/**
 * element picker overlay for selecting dom elements on any page.
 * injects a full-page overlay, highlights elements on hover,
 * and captures the element on click.
 */

import { getReactTree } from "@/content/react-fiber-walker";
import type { CapturedElement } from "@/shared/types";

// overlay elements
let overlay: HTMLDivElement | null = null;
let highlightBox: HTMLDivElement | null = null;
let tooltip: HTMLDivElement | null = null;
let isActive = false;
let hoveredElement: Element | null = null;

const OVERLAY_Z = 2_147_483_647; // max z-index
const HIGHLIGHT_COLOR = "rgba(56, 189, 248, 0.3)"; // sky-400 with transparency
const HIGHLIGHT_BORDER = "rgba(56, 189, 248, 0.8)";
const TOOLTIP_BG = "#171717"; // ash-900

export function startPicker(onCapture: (element: CapturedElement) => void): void {
  if (isActive) return;
  isActive = true;

  // create overlay container
  overlay = document.createElement("div");
  overlay.id = "wrench-picker-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: ${OVERLAY_Z};
    cursor: crosshair;
    pointer-events: auto;
  `;

  // highlight box (follows hovered element)
  highlightBox = document.createElement("div");
  highlightBox.style.cssText = `
    position: fixed;
    pointer-events: none;
    background: ${HIGHLIGHT_COLOR};
    border: 2px solid ${HIGHLIGHT_BORDER};
    border-radius: 3px;
    transition: all 0.08s ease-out;
    z-index: ${OVERLAY_Z};
    display: none;
  `;

  // tooltip showing element/component name
  tooltip = document.createElement("div");
  tooltip.style.cssText = `
    position: fixed;
    pointer-events: none;
    background: ${TOOLTIP_BG};
    color: white;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    z-index: ${OVERLAY_Z};
    display: none;
    white-space: nowrap;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
  `;

  document.body.appendChild(highlightBox);
  document.body.appendChild(tooltip);
  document.body.appendChild(overlay);

  overlay.addEventListener("mousemove", handleMouseMove);
  overlay.addEventListener("click", handleClick);
  overlay.addEventListener("contextmenu", handleCancel);
  document.addEventListener("keydown", handleKeyDown);

  function handleMouseMove(e: MouseEvent): void {
    // temporarily hide overlay to find the real element underneath
    overlay!.style.pointerEvents = "none";
    const target = document.elementFromPoint(e.clientX, e.clientY);
    overlay!.style.pointerEvents = "auto";

    if (!target || target === overlay || target === highlightBox || target === tooltip) {
      highlightBox!.style.display = "none";
      tooltip!.style.display = "none";
      hoveredElement = null;
      return;
    }

    hoveredElement = target;
    const rect = target.getBoundingClientRect();

    // position highlight box
    highlightBox!.style.display = "block";
    highlightBox!.style.top = `${rect.top}px`;
    highlightBox!.style.left = `${rect.left}px`;
    highlightBox!.style.width = `${rect.width}px`;
    highlightBox!.style.height = `${rect.height}px`;

    // build tooltip label
    const tagName = target.tagName.toLowerCase();
    const reactName = getReactComponentName(target);
    const label = reactName ? `<${reactName}> (${tagName})` : `<${tagName}>`;
    const id = target.id ? `#${target.id}` : "";
    const classes = Array.from(target.classList)
      .slice(0, 3)
      .map((c) => `.${c}`)
      .join("");

    tooltip!.textContent = `${label}${id}${classes}`;
    tooltip!.style.display = "block";

    // position tooltip above the element
    const tooltipRect = tooltip!.getBoundingClientRect();
    let tooltipTop = rect.top - tooltipRect.height - 6;
    let tooltipLeft = rect.left;

    // keep tooltip in viewport
    if (tooltipTop < 4) tooltipTop = rect.bottom + 6;
    if (tooltipLeft + tooltipRect.width > window.innerWidth - 4) {
      tooltipLeft = window.innerWidth - tooltipRect.width - 4;
    }

    tooltip!.style.top = `${tooltipTop}px`;
    tooltip!.style.left = `${tooltipLeft}px`;
  }

  function handleClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();

    if (!hoveredElement) return;

    const captured = captureElement(hoveredElement);
    cleanup();
    onCapture(captured);
  }

  function handleCancel(e: Event): void {
    e.preventDefault();
    cleanup();
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      cleanup();
      // notify the extension that the picker was cancelled
      chrome.runtime.sendMessage({ type: "WRENCH_PICKER_CANCELLED" });
    }
  }
}

export function stopPicker(): void {
  cleanup();
}

function cleanup(): void {
  isActive = false;
  hoveredElement = null;

  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  if (highlightBox) {
    highlightBox.remove();
    highlightBox = null;
  }
  if (tooltip) {
    tooltip.remove();
    tooltip = null;
  }

  document.removeEventListener("keydown", handleKeyDown);
}

// placeholder for the keydown handler reference - redefined in startPicker
function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    cleanup();
    chrome.runtime.sendMessage({ type: "WRENCH_PICKER_CANCELLED" });
  }
}

// ── element capture ──

function captureElement(el: Element): CapturedElement {
  const tagName = el.tagName.toLowerCase();
  const selector = buildCssSelector(el);
  const html = truncateHtml(el.outerHTML, 3000);
  const reactTree = getReactTree(el);

  return {
    tagName,
    selector,
    html,
    reactTree,
    pageUrl: window.location.href,
    capturedAt: Date.now(),
  };
}

function buildCssSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector += `#${current.id}`;
      parts.unshift(selector);
      break; // id is unique enough
    }

    const classes = Array.from(current.classList)
      .filter((c) => !c.startsWith("_") && c.length < 30) // skip generated class names
      .slice(0, 2);
    if (classes.length) {
      selector += `.${classes.join(".")}`;
    }

    // add nth-child if ambiguous
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName === current!.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-child(${index})`;
      }
    }

    parts.unshift(selector);
    current = current.parentElement;

    // limit depth
    if (parts.length >= 5) break;
  }

  return parts.join(" > ");
}

function truncateHtml(html: string, maxLen: number): string {
  if (html.length <= maxLen) return html;
  return html.slice(0, maxLen) + "<!-- truncated -->";
}

function getReactComponentName(el: Element): string | null {
  // find the react fiber on the element
  const fiberKey = Object.keys(el).find(
    (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
  );
  if (!fiberKey) return null;

  // cast: react attaches fiber nodes as non-enumerable properties on dom elements
  // at runtime. there is no typed api for this - it's a react internal.
  const elRecord = el as unknown as Record<string, unknown>;
  let fiber = elRecord[fiberKey] as FiberNode | null;
  while (fiber) {
    if (fiber.type && typeof fiber.type === "function") {
      // cast: react components have displayName/name but Function type doesn't declare them
      const fn = fiber.type as { displayName?: string; name?: string };
      const name = fn.displayName || fn.name;
      if (name && name !== "Anonymous") return name;
    }
    fiber = fiber.return;
  }

  return null;
}

// minimal fiber node type for traversal
interface FiberNode {
  type: unknown;
  return: FiberNode | null;
  child: FiberNode | null;
  sibling: FiberNode | null;
  memoizedProps: Record<string, unknown> | null;
}
