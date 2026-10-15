// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { EventItem } from "./session-timeline";
import { SafeMarkdown } from "./safe-markdown";

const theme = vi.hoisted(() => ({ resolvedTheme: "light" }));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>Start to Finish</text></svg>';
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
vi.mock("next-themes", () => ({ useTheme: () => theme }));

beforeEach(() => {
  theme.resolvedTheme = "light";
  vi.mocked(mermaid.render).mockResolvedValue({ svg, diagramType: "flowchart-v2" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const fence = (source: string) => "```mermaid\n" + source + "\n```";
const diagram = () => screen.findByRole("img", { name: /mermaid diagram/i });

describe("timeline Mermaid fences", () => {
  it("renders an assistant Mermaid fence as an accessible diagram", async () => {
    render(<SafeMarkdown content={fence("flowchart LR\n  Start --> Finish")} renderMermaid />);
    expect(await diagram()).toBeInTheDocument();
    expect(mermaid.render).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const summary = screen.getByText("View diagram source");
    fireEvent.click(summary);
    expect(summary.parentElement?.querySelector("pre")).toHaveAttribute("tabindex", "0");
    expect(summary.parentElement?.querySelector("code")).toHaveTextContent("Start --> Finish");
  });

  it("enables diagrams in assistant events but preserves raw user prompts", async () => {
    const props = {
      sessionId: "session",
      currentParticipantId: null,
      participantProfiles: {},
      onOpenMedia: () => {},
    };
    const content = fence("sequenceDiagram\n Alice->>Bob: Hello");
    const { rerender } = render(
      <EventItem
        {...props}
        event={{ type: "user_message", messageId: "m", timestamp: 1, content }}
      />
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
    rerender(
      <EventItem
        {...props}
        event={{ type: "token", sandboxId: "sandbox-1", messageId: "m", timestamp: 2, content }}
      />
    );
    expect(await diagram()).toBeInTheDocument();
  });

  it("keeps non-timeline Mermaid and non-Mermaid highlighting unchanged", () => {
    const { container, rerender } = render(
      <SafeMarkdown content={fence("flowchart LR\n PR --> Body")} />
    );
    expect(container.querySelector("pre code.language-mermaid")).toHaveTextContent("PR --> Body");
    expect(mermaid.render).not.toHaveBeenCalled();
    const content = "```js\nconst answer = 42;\n```\n\nInline `mermaid`.";
    rerender(<SafeMarkdown content={content} renderMermaid />);
    expect(container.querySelector("pre code.hljs.language-js .hljs-keyword")).toHaveTextContent(
      "const"
    );
    expect(container.querySelector("pre")).toHaveClass("not-prose", "overflow-x-auto");
    expect(container.querySelector("code.font-mono")).toHaveTextContent("mermaid");
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("does no diagram processing while tokens arrive, then renders only once", async () => {
    const source = fence("flowchart TD\n Stream --> Complete");
    const { rerender, container } = render(<SafeMarkdown content="" renderMermaid />);
    for (let i = 1; i < source.length; i++) {
      rerender(<SafeMarkdown content={source.slice(0, i)} renderMermaid />);
    }
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(container.querySelector("figure")).not.toBeInTheDocument();
    rerender(<SafeMarkdown content={source} renderMermaid />);
    const image = await diagram();
    for (let i = 0; i < 5; i++) {
      rerender(<SafeMarkdown content={source + "\nMore text. ".repeat(i + 1)} renderMermaid />);
    }
    expect(screen.getByRole("img")).toBe(image);
    expect(mermaid.render).toHaveBeenCalledOnce();
  });

  it("supports tilde fences inside block quotes", async () => {
    render(<SafeMarkdown content={'> ~~~mermaid\n> pie\n> "Tests": 10\n> ~~~'} renderMermaid />);
    expect(await diagram()).toBeInTheDocument();
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.any(String),
      'pie\n"Tests": 10\n',
      expect.any(HTMLElement)
    );
  });

  it("falls back to readable source and keeps surrounding text after render rejection", async () => {
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("invalid source"));
    const content = "Before\n\n" + fence("not a supported diagram") + "\n\nAfter";
    const { container } = render(<SafeMarkdown content={content} renderMermaid />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(container.querySelector("pre code")).toHaveTextContent("not a supported diagram");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  it("uses completed cache entries immediately after virtual row remounts", async () => {
    const content = fence("flowchart LR\n Cached --> Diagram");
    const first = render(<SafeMarkdown content={content} renderMermaid />);
    const image = await diagram();
    const src = image.getAttribute("src");
    first.unmount();
    render(<SafeMarkdown content={content} renderMermaid />);
    expect(screen.getByRole("img")).toHaveAttribute("src", src);
    expect(mermaid.render).toHaveBeenCalledOnce();
  });

  it("updates the theme without blanking the current diagram", async () => {
    const content = fence("flowchart LR\n Light --> Dark");
    const { rerender } = render(<SafeMarkdown content={content} renderMermaid />);
    const image = await diagram();
    theme.resolvedTheme = "dark";
    rerender(<SafeMarkdown content={content} renderMermaid />);
    expect(screen.getByRole("img")).toBe(image);
    await waitFor(() =>
      expect(mermaid.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "dark" })
      )
    );
    await act(async () => {});
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("falls back if the browser cannot decode the generated image", async () => {
    const { container } = render(
      <SafeMarkdown content={fence("flowchart LR\n Decode --> Error")} renderMermaid />
    );
    fireEvent.error(await diagram());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("pre")).toHaveTextContent("Decode --> Error");
  });

  it("leaves general Markdown sanitization restrictive", () => {
    const { container } = render(
      <SafeMarkdown
        content={
          '<svg onload="alert(1)"><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>\n\n[bad](javascript:alert(1))'
        }
        renderMermaid
      />
    );
    expect(container.querySelector("svg, foreignObject, iframe, script, [onload]")).toBeNull();
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("does not invoke the browser renderer during server rendering", () => {
    const html = renderToString(
      <SafeMarkdown content={fence("flowchart LR\n Server --> Source")} renderMermaid />
    );
    expect(html).toContain("language-mermaid");
    expect(html).not.toContain("data:image");
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
