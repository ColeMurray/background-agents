// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ErrorBoundaryHandler } from "next/dist/client/components/error-boundary";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import SessionError from "./error";

const renderError = new Error("An error occurred in the Server Components render.");

function ServerOutput({ failed }: { failed: boolean }) {
  if (failed) throw renderError;
  return <p>Session loaded</p>;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionError", () => {
  it.each([false, true])(
    "fetches fresh server output on retry (first retry still fails: %s)",
    (firstRetryFails) => {
      const fetchServerOutput = vi.fn().mockReturnValueOnce(firstRetryFails).mockReturnValue(false);

      function SessionRoute() {
        const [failed, setFailed] = useState(true);
        return (
          <AppRouterContext.Provider
            value={{
              back: vi.fn(),
              forward: vi.fn(),
              push: vi.fn(),
              replace: vi.fn(),
              prefetch: vi.fn(),
              bfcacheId: "session-1",
              // Model a fresh RSC response replacing the previously failed output.
              refresh: () => setFailed(fetchServerOutput()),
            }}
          >
            <ErrorBoundaryHandler pathname="/session/session-1" errorComponent={SessionError}>
              <ServerOutput failed={failed} />
            </ErrorBoundaryHandler>
          </AppRouterContext.Provider>
        );
      }

      render(<SessionRoute />);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Session data is temporarily unavailable."
      );
      expect(fetchServerOutput).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(fetchServerOutput).toHaveBeenCalledTimes(1);

      if (firstRetryFails) {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Session data is temporarily unavailable."
        );
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(fetchServerOutput).toHaveBeenCalledTimes(2);
      }

      expect(screen.getByText("Session loaded")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  );
});
