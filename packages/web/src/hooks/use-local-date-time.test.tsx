// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useLocalDateTime } from "./use-local-date-time";

const TIMESTAMP = "2026-09-06T12:34:56.000Z";

describe("useLocalDateTime", () => {
  it("formats with the browser locale in client renders", () => {
    const { result } = renderHook(() => useLocalDateTime(TIMESTAMP));

    expect(result.current).toBe(new Date(TIMESTAMP).toLocaleString());
  });

  it("uses deterministic ISO text during server rendering", () => {
    function Timestamp() {
      return useLocalDateTime(TIMESTAMP);
    }

    expect(renderToString(<Timestamp />)).toBe(TIMESTAMP);
  });
});
