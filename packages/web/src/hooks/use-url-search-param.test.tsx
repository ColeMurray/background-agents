// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search";
import { useUrlSearchParam } from "./use-url-search-param";

// A router whose writes land only when the test says so, to reproduce slow navigations.
const url = vi.hoisted(() => ({
  params: new URLSearchParams(),
  writes: [] as string[],
  listeners: new Set<() => void>(),
}));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    url.listeners.add(listener);
    return () => url.listeners.delete(listener);
  };
  return {
    useSearchParams: () => useSyncExternalStore(subscribe, () => url.params),
    usePathname: () => "/page",
    useRouter: () => ({ replace: (href: string) => url.writes.push(href) }),
  };
});

function setUrl(query: string) {
  url.params = new URLSearchParams(query);
  act(() => url.listeners.forEach((listener) => listener()));
}
/** Land the oldest write the hook made. */
function land() {
  const href = url.writes.shift();
  if (href === undefined) throw new Error("no write to land");
  setUrl(href.split("?")[1] ?? "");
}
const waitForDebounce = () => act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
// Under two characters is "no search yet"; "!" marks text that must not be written.
const commit = (raw: string) =>
  raw.includes("!") ? null : raw.trim().length < 2 ? "" : raw.trim();

describe("useUrlSearchParam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    url.params = new URLSearchParams("tab=memories");
    url.writes = [];
  });
  afterEach(() => vi.useRealTimers());

  const render = () => renderHook(() => useUrlSearchParam("search", commit));

  it("writes typed text after the debounce, keeping other parameters", () => {
    const { result } = render();
    act(() => result.current.setText("rspec"));
    expect(url.writes).toEqual([]);
    waitForDebounce();
    expect(url.writes).toEqual(["/page?tab=memories&search=rspec"]);
    land();
    expect(result.current).toMatchObject({ text: "rspec", value: "rspec" });
  });

  it("keeps an edit that commits to no search when its write lands", () => {
    url.params = new URLSearchParams("tab=memories&search=rspec");
    const { result } = render();
    act(() => result.current.setText("r"));
    waitForDebounce();
    expect(url.writes).toEqual(["/page?tab=memories"]);
    land();
    expect(result.current).toMatchObject({ text: "r", value: "" });
  });

  it("writes a reversal made before the previous write lands", () => {
    url.params = new URLSearchParams("search=rspec");
    const { result } = render();
    act(() => result.current.setText("rspecs"));
    waitForDebounce();
    act(() => result.current.setText("rspec"));
    waitForDebounce();
    expect(url.writes).toEqual(["/page?search=rspecs", "/page?search=rspec"]);
    land();
    expect(result.current.text).toBe("rspec");
    land();
    expect(result.current).toMatchObject({ text: "rspec", value: "rspec" });
  });

  it("keeps unwritable text when an earlier write lands late", () => {
    const { result } = render();
    act(() => result.current.setText("rspec"));
    waitForDebounce();
    act(() => result.current.setText("rspec!"));
    waitForDebounce();
    expect(url.writes).toEqual(["/page?tab=memories&search=rspec"]);
    land();
    expect(result.current).toMatchObject({ text: "rspec!", value: "rspec" });
  });

  it("lets navigation replace the box when no write is in flight", () => {
    const { result } = render();
    act(() => result.current.setText("draft"));
    setUrl("tab=memories&search=docker");
    expect(result.current).toMatchObject({ text: "docker", value: "docker" });
    waitForDebounce();
    expect(url.writes).toEqual([]);
  });

  it("does not write when the text already matches the URL", () => {
    url.params = new URLSearchParams("search=rspec");
    const { result } = render();
    act(() => result.current.setText("rspec "));
    waitForDebounce();
    expect(url.writes).toEqual([]);
    expect(result.current.text).toBe("rspec ");
  });
});
