// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMermaid, type MermaidImage } from "@/lib/mermaid-renderer";
import { EventItem } from "./session-timeline";
import { SafeMarkdown } from "./safe-markdown";

const theme = vi.hoisted(() => ({ resolvedTheme: "light" as string | undefined }));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>Start to Finish</text></svg>';
const renderedImage: MermaidImage = {
  src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
  width: 200,
  height: 100,
};
vi.mock("@/lib/mermaid-renderer", () => ({ renderMermaid: vi.fn() }));
vi.mock("next-themes", () => ({ useTheme: () => theme }));

beforeEach(() => {
  theme.resolvedTheme = "light";
  vi.mocked(renderMermaid).mockReset().mockResolvedValue(renderedImage);
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
    expect(renderMermaid).toHaveBeenCalledExactlyOnceWith(
      "flowchart LR\n  Start --> Finish\n",
      false
    );
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
    expect(renderMermaid).not.toHaveBeenCalled();
    rerender(
      <EventItem
        {...props}
        event={{ type: "token", sandboxId: "sandbox-1", messageId: "m", timestamp: 2, content }}
      />
    );
    expect(await diagram()).toBeInTheDocument();
    expect(renderMermaid).toHaveBeenCalledExactlyOnceWith(
      "sequenceDiagram\n Alice->>Bob: Hello\n",
      false
    );
  });

  it("keeps non-timeline Mermaid and non-Mermaid highlighting unchanged", () => {
    const { container, rerender } = render(
      <SafeMarkdown content={fence("flowchart LR\n PR --> Body")} />
    );
    expect(container.querySelector("pre code.language-mermaid")).toHaveTextContent("PR --> Body");
    expect(container.querySelector("pre code")).toHaveAttribute("data-fence-closed", "true");
    expect(container.querySelector("pre")).not.toHaveAttribute("data-fence-closed");
    expect(renderMermaid).not.toHaveBeenCalled();
    const content = "```js\nconst answer = 42;\n```\n\nInline `mermaid`.";
    rerender(<SafeMarkdown content={content} renderMermaid />);
    expect(container.querySelector("pre code.hljs.language-js .hljs-keyword")).toHaveTextContent(
      "const"
    );
    expect(container.querySelector("pre")).toHaveClass("not-prose", "overflow-x-auto");
    expect(container.querySelector("pre")).not.toHaveAttribute("tabindex");
    expect(container.querySelector("code.font-mono")).toHaveTextContent("mermaid");
    expect(renderMermaid).not.toHaveBeenCalled();
  });

  it("does no diagram processing while tokens arrive, then renders only once", async () => {
    const source = fence("flowchart TD\n Stream --> Complete");
    const { rerender, container } = render(<SafeMarkdown content="" renderMermaid />);
    for (let i = 1; i < source.length; i++) {
      rerender(<SafeMarkdown content={source.slice(0, i)} renderMermaid />);
    }
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(container.querySelector("figure")).not.toBeInTheDocument();
    rerender(<SafeMarkdown content={source} renderMermaid />);
    const image = await diagram();
    for (let i = 0; i < 5; i++) {
      rerender(<SafeMarkdown content={source + "\nMore text. ".repeat(i + 1)} renderMermaid />);
    }
    expect(screen.getByRole("img")).toBe(image);
    expect(renderMermaid).toHaveBeenCalledExactlyOnceWith(
      "flowchart TD\n Stream --> Complete\n",
      false
    );
  });

  it("supports tilde fences inside block quotes", async () => {
    render(<SafeMarkdown content={'> ~~~mermaid\n> pie\n> "Tests": 10\n> ~~~'} renderMermaid />);
    expect(await diagram()).toBeInTheDocument();
    expect(renderMermaid).toHaveBeenCalledExactlyOnceWith('pie\n"Tests": 10\n', false);
  });

  it.each([
    ["unordered list", "- item\n\n", "  "],
    ["ordered list", "1. item\n\n", "   "],
    ["block quote", "", "> "],
    ["quoted list", "> - item\n>\n", ">   "],
  ])("preserves nested diagram DOM and browser state in a %s", async (name, opening, prefix) => {
    const source = `flowchart LR\n Nested --> ${name.replaceAll(" ", "_")}`;
    const content =
      opening +
      fence(source)
        .split("\n")
        .map((line) => prefix + line)
        .join("\n");
    const { container, rerender } = render(<SafeMarkdown content={content} renderMermaid />);
    const image = await diagram();
    const figure = image.closest("figure");
    const details = container.querySelector("details")!;
    const viewport = image.parentElement!;
    const ancestors = [...container.querySelectorAll("ul, ol, blockquote")];
    fireEvent.click(screen.getByText("View diagram source"));
    expect(details).toHaveAttribute("open");
    viewport.scrollLeft = 72;
    viewport.scrollTop = 48;

    for (let i = 1; i <= 3; i++) {
      rerender(<SafeMarkdown content={content + "\n\nMore text. ".repeat(i)} renderMermaid />);
      expect(screen.getByRole("img")).toBe(image);
      expect(image.closest("figure")).toBe(figure);
      expect(image.parentElement).toBe(viewport);
      expect(container.querySelector("details")).toBe(details);
      expect(details).toHaveAttribute("open");
      expect(viewport.scrollLeft).toBe(72);
      expect(viewport.scrollTop).toBe(48);
      const updatedAncestors = container.querySelectorAll("ul, ol, blockquote");
      expect(updatedAncestors).toHaveLength(ancestors.length);
      ancestors.forEach((ancestor, index) => expect(updatedAncestors[index]).toBe(ancestor));
    }
    expect(renderMermaid).toHaveBeenCalledExactlyOnceWith(source + "\n", false);
  });

  it.each([
    ["four spaces", "    ```"],
    ["tab indentation", "\t```"],
    ["stray quote marker", "> ```"],
    ["leading NBSP", "\u00a0```"],
    ["trailing NBSP", "```\u00a0"],
  ])("keeps an invalid closing fence as source: %s", async (_name, closing) => {
    const { container } = render(
      <SafeMarkdown
        content={"```mermaid\nflowchart LR\n Invalid --> Closing\n" + closing}
        renderMermaid
      />
    );
    await act(async () => {});
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("Invalid --> Closing");
    expect(container.querySelector("code")).not.toHaveAttribute("data-fence-closed");
  });

  it.each(["\r", "\r\n"])("renders a complete fence with %j line endings", async (ending) => {
    const source = `flowchart LR${ending} Line --> Ending_${ending.length}`;
    render(
      <SafeMarkdown content={"```mermaid" + ending + source + ending + "```"} renderMermaid />
    );
    expect(await diagram()).toBeInTheDocument();
    expect(renderMermaid).toHaveBeenCalledExactlyOnceWith(source + "\n", false);
  });

  it("falls back to readable source and keeps surrounding text after render rejection", async () => {
    vi.mocked(renderMermaid).mockRejectedValueOnce(new Error("invalid source"));
    const content = "Before\n\n" + fence("not a supported diagram") + "\n\nAfter";
    const { container } = render(<SafeMarkdown content={content} renderMermaid />);
    await waitFor(() =>
      expect(renderMermaid).toHaveBeenCalledExactlyOnceWith("not a supported diagram\n", false)
    );
    await act(async () => {});
    expect(container.querySelector("pre code")).toHaveTextContent("not a supported diagram");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  it("keeps source visible while loading and when the renderer returns null", async () => {
    let resolveImage!: (image: MermaidImage | null) => void;
    vi.mocked(renderMermaid).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve;
        })
    );
    const source = "flowchart LR\n Loading --> Source";
    const { container } = render(<SafeMarkdown content={fence(source)} renderMermaid />);
    await waitFor(() =>
      expect(renderMermaid).toHaveBeenCalledExactlyOnceWith(source + "\n", false)
    );
    expect(container.querySelector("pre code")).toHaveTextContent("Loading --> Source");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await act(async () => {
      resolveImage(null);
    });
    expect(container.querySelector("pre code")).toHaveTextContent("Loading --> Source");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("never shows the previous source's image while a replacement is pending", async () => {
    const { container, rerender } = render(
      <SafeMarkdown content={fence("flowchart LR\n Original --> Image")} renderMermaid />
    );
    expect(await diagram()).toBeInTheDocument();
    let resolveImage!: (image: MermaidImage | null) => void;
    vi.mocked(renderMermaid).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve;
        })
    );
    const source = "flowchart LR\n Replacement --> Image";
    rerender(<SafeMarkdown content={fence(source)} renderMermaid />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("Replacement --> Image");
    await waitFor(() => expect(renderMermaid).toHaveBeenLastCalledWith(source + "\n", false));
    const replacement = { ...renderedImage, src: renderedImage.src + "#replacement" };
    await act(async () => {
      resolveImage(replacement);
    });
    expect(await diagram()).toHaveAttribute("src", replacement.src);
  });

  it("uses completed cache entries immediately after virtual row remounts", async () => {
    const content = fence("flowchart LR\n Cached --> Diagram");
    const first = render(<SafeMarkdown content={content} renderMermaid />);
    const image = await diagram();
    const src = image.getAttribute("src");
    first.unmount();
    render(<SafeMarkdown content={content} renderMermaid />);
    expect(screen.getByRole("img")).toHaveAttribute("src", src);
    expect(renderMermaid).toHaveBeenCalledOnce();
  });

  it("waits for the resolved theme before loading a diagram", async () => {
    theme.resolvedTheme = undefined;
    const content = fence("sequenceDiagram\n Hydration->>Dark: Ready");
    const { rerender } = render(<SafeMarkdown content={content} renderMermaid />);
    await act(async () => {});
    expect(renderMermaid).not.toHaveBeenCalled();
    theme.resolvedTheme = "dark";
    rerender(<SafeMarkdown content={content} renderMermaid />);
    expect(await diagram()).toBeInTheDocument();
    expect(renderMermaid).toHaveBeenCalledExactlyOnceWith(
      "sequenceDiagram\n Hydration->>Dark: Ready\n",
      true
    );
  });

  it.each([
    ["root", "", ""],
    ["block quote", "", "> "],
    ["list", "- item\n\n", "  "],
  ])(
    "keeps the previous %s diagram while streaming and changing theme",
    async (name, opening, prefix) => {
      const source = `flowchart LR\n Light_${name.replaceAll(" ", "_")} --> Dark`;
      const content =
        opening +
        fence(source)
          .split("\n")
          .map((line) => prefix + line)
          .join("\n");
      const { rerender } = render(<SafeMarkdown content={content} renderMermaid />);
      const image = await diagram();
      const darkImage = { ...renderedImage, src: renderedImage.src + "#dark" };
      let resolveDark!: (image: MermaidImage | null) => void;
      vi.mocked(renderMermaid).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDark = resolve;
          })
      );
      theme.resolvedTheme = "dark";
      rerender(<SafeMarkdown content={content + "\n\nMore tokens."} renderMermaid />);
      expect(screen.getByRole("img")).toBe(image);
      await waitFor(() => expect(renderMermaid).toHaveBeenLastCalledWith(source + "\n", true));
      expect(screen.getByRole("img")).toBe(image);
      expect(image).toHaveAttribute("src", renderedImage.src);
      await act(async () => {
        resolveDark(darkImage);
      });
      expect(screen.getByRole("img")).toBe(image);
      expect(image).toHaveAttribute("src", darkImage.src);
      expect(renderMermaid).toHaveBeenCalledTimes(2);
    }
  );

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
    expect(renderMermaid).not.toHaveBeenCalled();
  });

  it("does not invoke the browser renderer during server rendering", () => {
    const html = renderToString(
      <SafeMarkdown content={fence("flowchart LR\n Server --> Source")} renderMermaid />
    );
    expect(html).toContain("language-mermaid");
    expect(html).not.toContain("data:image");
    expect(renderMermaid).not.toHaveBeenCalled();
  });
});
