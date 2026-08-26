// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import { VncSection } from "./vnc-section";

expect.extend(matchers);

afterEach(cleanup);

describe("VncSection", () => {
  it("links active desktops through the noVNC client", () => {
    render(
      <VncSection url="https://desktop.example/tunnel" password="p&a ss" sandboxStatus="ready" />
    );

    expect(screen.getByRole("link", { name: "Open Desktop" })).toHaveAttribute(
      "href",
      "https://desktop.example/tunnel/vnc.html?autoconnect=true&resize=scale#password=p%26a+ss"
    );
  });

  it("waits for the password before linking the desktop", () => {
    const { rerender } = render(
      <VncSection url="https://desktop.example" password={null} sandboxStatus="ready" />
    );

    expect(screen.getByText("Desktop unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    rerender(<VncSection url="https://desktop.example" password="secret" sandboxStatus="ready" />);

    expect(screen.getByRole("link", { name: "Open Desktop" })).toHaveAttribute(
      "href",
      "https://desktop.example/vnc.html?autoconnect=true&resize=scale#password=secret"
    );
  });

  it("does not link unsafe URLs or inactive sandboxes", () => {
    const { rerender } = render(
      <VncSection url="javascript:alert(1)" password="secret" sandboxStatus="ready" />
    );
    expect(screen.getByText("Desktop unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    rerender(
      <VncSection url="https://desktop.example" password="secret" sandboxStatus="spawning" />
    );
    expect(screen.getByText("Desktop starting…")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
