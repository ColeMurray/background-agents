// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search";
import { useUrlSearchParam } from "./use-url-search-param";

// Like Next: history.replaceState updates the address bar at once, while useSearchParams
// follows in a later (transition) render — which lands only when the test says so.
const url = vi.hoisted(() => ({
  params: new URLSearchParams(),
  echoes: [] as string[],
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
  };
});

const realReplaceState = window.history.replaceState.bind(window.history);
let writes: string[] = [];
function setUrl(query: string) {
  realReplaceState(null, "", query ? `/page?${query}` : "/page");
  url.params = new URLSearchParams(query);
  act(() => url.listeners.forEach((listener) => listener()));
}
/** Land the oldest write's echo in useSearchParams. */
function land() {
  const query = url.echoes.shift();
  if (query === undefined) throw new Error("no echo to land");
  url.params = new URLSearchParams(query);
  act(() => url.listeners.forEach((listener) => listener()));
}
// Like router.push or a Link: useSearchParams renders the new URL first, and Next updates the
// address bar afterwards, in an insertion effect, without another render.
function navigate(query: string) {
  url.params = new URLSearchParams(query);
  act(() => url.listeners.forEach((listener) => listener()));
  realReplaceState(null, "", query ? `/page?${query}` : "/page");
}
const waitForDebounce = () => act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
// Under two characters is "no search yet"; "!" marks text that must not be written.
const commit = (raw: string) =>
  raw.includes("!") ? null : raw.trim().length < 2 ? "" : raw.trim();

describe("useUrlSearchParam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    url.echoes = [];
    setUrl("tab=memories");
    vi.spyOn(window.history, "replaceState").mockImplementation((state, unused, href) => {
      realReplaceState(state, unused, href);
      writes.push(String(href));
      url.echoes.push(String(href).split("?")[1] ?? "");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const render = () => renderHook(() => useUrlSearchParam("search", commit));

  it("writes typed text after the debounce, keeping other parameters", () => {
    const { result } = render();
    act(() => result.current.setText("rspec"));
    expect(writes).toEqual([]);
    waitForDebounce();
    expect(writes).toEqual(["/page?tab=memories&search=rspec"]);
    land();
    expect(result.current).toMatchObject({ text: "rspec", value: "rspec" });
  });

  it("keeps an edit that commits to no search when its write lands", () => {
    setUrl("tab=memories&search=rspec");
    const { result } = render();
    act(() => result.current.setText("r"));
    waitForDebounce();
    expect(writes).toEqual(["/page?tab=memories"]);
    land();
    expect(result.current).toMatchObject({ text: "r", value: "" });
  });

  it("writes a reversal made before the previous write lands", () => {
    setUrl("search=rspec");
    const { result } = render();
    act(() => result.current.setText("rspecs"));
    waitForDebounce();
    act(() => result.current.setText("rspec"));
    waitForDebounce();
    expect(writes).toEqual(["/page?search=rspecs", "/page?search=rspec"]);
    // Next renders both writes in one transition, so the older value is not expected to show on
    // its own. If it did, the box would follow it until the newer write lands a render later.
    land();
    land();
    expect(result.current).toMatchObject({ text: "rspec", value: "rspec" });
  });

  it("keeps unwritable text when an earlier write lands late", () => {
    const { result } = render();
    act(() => result.current.setText("rspec"));
    waitForDebounce();
    act(() => result.current.setText("rspec!"));
    waitForDebounce();
    expect(writes).toEqual(["/page?tab=memories&search=rspec"]);
    land();
    expect(result.current).toMatchObject({ text: "rspec!", value: "rspec" });
  });

  it("lets navigation replace the box when nothing is waiting to be written", () => {
    const { result } = render();
    setUrl("tab=memories&search=docker");
    expect(result.current).toMatchObject({ text: "docker", value: "docker" });
  });

  it("does not write when the text already matches the URL", () => {
    setUrl("search=rspec");
    const { result } = render();
    act(() => result.current.setText("rspec "));
    waitForDebounce();
    expect(writes).toEqual([]);
    expect(result.current.text).toBe("rspec ");
  });

  it("keeps a keystroke made between a write and its echo", () => {
    const { result } = render();
    act(() => result.current.setText("rspec"));
    waitForDebounce();
    act(() => result.current.setText("rspecx"));
    land();
    expect(result.current.text).toBe("rspecx");
    waitForDebounce();
    land();
    expect(result.current).toMatchObject({ text: "rspecx", value: "rspecx" });
  });

  it("a write whose echo never lands does not freeze later navigation", () => {
    setUrl("search=rspec");
    const { result } = render();
    act(() => result.current.setText("docker"));
    waitForDebounce();
    url.echoes = [];
    setUrl("search=go");
    setUrl("search=back");
    expect(result.current).toMatchObject({ text: "back", value: "back" });
  });

  it("a reversal merged by the router does not freeze later navigation", () => {
    setUrl("search=rspec");
    const { result } = render();
    act(() => result.current.setText("rspecs"));
    waitForDebounce();
    act(() => result.current.setText("rspec"));
    waitForDebounce();
    url.echoes = [];
    setUrl("search=go");
    expect(result.current).toMatchObject({ text: "go", value: "go" });
  });

  it("lets navigation replace the box, including text not yet written", () => {
    const { result } = render();
    act(() => result.current.setText("draft"));
    setUrl("tab=memories&search=docker");
    expect(result.current).toMatchObject({ text: "docker", value: "docker" });
    waitForDebounce();
    expect(writes).toEqual([]);
  });

  it("follows navigation that keeps the search after a write whose echo never lands", () => {
    setUrl("search=rspec");
    const { result } = render();
    act(() => result.current.setText("docker"));
    waitForDebounce();
    url.echoes = [];
    navigate("search=rspec&memoryId=other");
    expect(result.current).toMatchObject({ text: "rspec", value: "rspec" });
    waitForDebounce();
    expect(writes).toEqual(["/page?search=docker"]);
  });

  it("follows navigation directly back to the last rendered query after a dropped echo", () => {
    setUrl("search=rspec");
    const { result } = render();
    act(() => result.current.setText("docker"));
    waitForDebounce();
    url.echoes = [];

    navigate("search=rspec");

    expect(result.current).toMatchObject({ text: "rspec", value: "rspec" });
  });

  it("follows router navigation that renders before the address bar updates", () => {
    const { result } = render();
    navigate("tab=memories&search=docker");
    expect(result.current).toMatchObject({ text: "docker", value: "docker" });
  });

  it("follows navigation after the URL already held the typed text", () => {
    const { result } = render();
    act(() => result.current.setText("docker"));
    setUrl("tab=memories&search=docker"); // navigation to the same value, inside the window
    waitForDebounce();
    expect(writes).toEqual([]);
    setUrl("tab=memories&search=go");
    expect(result.current).toMatchObject({ text: "go", value: "go" });
  });

  it("unwritable text is replaced by later navigation", () => {
    const { result } = render();
    act(() => result.current.setText("docker"));
    act(() => result.current.setText("docker!")); // cancels the pending write
    waitForDebounce();
    expect(writes).toEqual([]);
    setUrl("tab=memories&search=go");
    expect(result.current).toMatchObject({ text: "go", value: "go" });
  });

  it("does not write after unmount", () => {
    const { result, unmount } = render();
    act(() => result.current.setText("docker"));
    unmount();
    waitForDebounce();
    expect(writes).toEqual([]);
  });
  it("keeps the entry's app state and drops Next's keys so Next still syncs the URL", () => {
    realReplaceState(
      { openInspectSettingsDetail: true, __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} },
      "",
      "/page?tab=memories"
    );
    const { result } = render();
    act(() => result.current.setText("rspec"));
    waitForDebounce();
    expect(window.history.replaceState).toHaveBeenLastCalledWith(
      { openInspectSettingsDetail: true },
      "",
      "/page?tab=memories&search=rspec"
    );
  });
});
