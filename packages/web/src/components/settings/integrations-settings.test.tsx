// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { IntegrationsSettings } from "./integrations-settings";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("IntegrationsSettings", () => {
  it("does not list sandbox settings as a dedicated integration", () => {
    const { container } = render(<IntegrationsSettings />);

    expect(container.querySelector('a[href="/settings/integrations/sandbox"]')).toBeNull();
    expect(screen.getByRole("link", { name: /github bot/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /linear agent/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /code server/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /slack/i })).toBeInTheDocument();
  });
});
