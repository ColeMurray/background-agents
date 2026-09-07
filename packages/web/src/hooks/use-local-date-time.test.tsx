// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { useLocalDateTime } from "./use-local-date-time";

function LocalDateTime({ timestamp }: { timestamp: number }) {
  const value = useLocalDateTime(timestamp);
  return <span>{value}</span>;
}

expect.extend(matchers);
afterEach(cleanup);

describe("useLocalDateTime", () => {
  it("uses a stable empty server snapshot and local formatting in the browser", () => {
    const timestamp = 1_700_000_000_000;

    expect(renderToString(<LocalDateTime timestamp={timestamp} />)).toBe("<span></span>");

    render(<LocalDateTime timestamp={timestamp} />);
    expect(screen.getByText(new Date(timestamp).toLocaleString())).toBeInTheDocument();
  });
});
