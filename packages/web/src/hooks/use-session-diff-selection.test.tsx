// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDiffSelection } from "./use-session-diff-selection";

const FILE_A = { repositoryPosition: 0, path: "src/a.ts" };
const FILE_B = { repositoryPosition: 0, path: "src/b.ts" };

// jsdom has no layout, so offsetParent stands in for "rendered".
function setRendered(element: HTMLElement, rendered: boolean) {
  Object.defineProperty(element, "offsetParent", {
    configurable: true,
    get: () => (rendered ? document.body : null),
  });
}

function fileRow(path: string, parent: HTMLElement = document.body) {
  const row = document.createElement("button");
  row.dataset.diffRepositoryPosition = "0";
  row.dataset.diffPath = path;
  setRendered(row, true);
  parent.append(row);
  return row;
}

function renderSelection() {
  const onOpen = vi.fn();
  const focusFallback = vi.fn();
  const view = renderHook(() => useSessionDiffSelection({ onOpen, focusFallback }));
  return { ...view, onOpen, focusFallback };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("useSessionDiffSelection", () => {
  it("runs onOpen when a diff opens but not when moving between its files", () => {
    const { result, onOpen } = renderSelection();

    act(() => result.current.openDiff(FILE_A));
    act(() => result.current.selectDiff(FILE_B));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(result.current.selectedDiff).toEqual(FILE_B);
  });

  it("returns focus to the row of the file being viewed, not the one first opened", () => {
    const rowA = fileRow(FILE_A.path);
    const rowB = fileRow(FILE_B.path);
    const { result } = renderSelection();

    rowA.focus();
    act(() => result.current.openDiff(FILE_A));
    act(() => result.current.selectDiff(FILE_B));
    act(() => result.current.closeDiff());

    expect(rowB).toHaveFocus();
    expect(result.current.selectedDiff).toBeNull();
  });

  it("returns to whatever opened the diff when the file's row is not shown", () => {
    const row = fileRow(FILE_A.path);
    setRendered(row, false);
    const link = document.createElement("a");
    link.href = "#src/a.ts";
    setRendered(link, true);
    document.body.append(link);
    const { result } = renderSelection();

    link.focus();
    act(() => result.current.openDiff(FILE_A));
    act(() => result.current.closeDiff());

    expect(link).toHaveFocus();
  });

  it("uses the fallback when the sidebar is hidden while the diff is open", () => {
    const row = fileRow(FILE_A.path);
    const { result, focusFallback } = renderSelection();

    row.focus();
    act(() => result.current.openDiff(FILE_A));
    setRendered(row, false);
    act(() => result.current.closeDiff());

    expect(focusFallback).toHaveBeenCalledOnce();
  });

  it("skips rows inside an inert container such as the closed mobile details sheet", () => {
    const sheet = document.createElement("div");
    document.body.append(sheet);
    const row = fileRow(FILE_A.path, sheet);
    const { result, focusFallback } = renderSelection();

    row.focus();
    act(() => result.current.openDiff(FILE_A));
    sheet.setAttribute("inert", "");
    act(() => result.current.closeDiff());

    expect(focusFallback).toHaveBeenCalledOnce();
  });
});
