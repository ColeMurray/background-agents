// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { useState } from "react";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { Combobox, type ComboboxOption, type ComboboxGroup } from "./combobox";

expect.extend(matchers);

afterEach(cleanup);

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const FLAT_ITEMS: ComboboxOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
  { value: "dragonfruit", label: "Dragonfruit" },
  { value: "elderberry", label: "Elderberry" },
];

const GROUPED_ITEMS: ComboboxGroup[] = [
  {
    category: "Fruit",
    options: [
      { value: "apple", label: "Apple" },
      { value: "banana", label: "Banana" },
    ],
  },
  {
    category: "Vegetable",
    options: [
      { value: "carrot", label: "Carrot" },
      { value: "daikon", label: "Daikon" },
    ],
  },
];

function renderCombobox(
  props: Partial<React.ComponentProps<typeof Combobox>> & {
    items?: ComboboxOption[] | ComboboxGroup[];
  } = {}
) {
  const { items = FLAT_ITEMS, ...rest } = props;
  const result = render(
    <Combobox value="" onChange={() => {}} items={items} {...rest}>
      <span>Open</span>
    </Combobox>
  );
  return { ...result, trigger: screen.getByRole("button", { name: /open/i }) };
}

describe("Combobox", () => {
  describe("keyboard navigation", () => {
    it("arrow down advances the active option", async () => {
      const user = userEvent.setup();
      const { trigger } = renderCombobox();

      await user.click(trigger);

      const options = screen.getAllByRole("option");

      await user.keyboard("{ArrowDown}");
      expect(options[1]).toHaveClass("bg-muted");

      await user.keyboard("{ArrowDown}");
      expect(options[2]).toHaveClass("bg-muted");
      expect(options[1]).not.toHaveClass("bg-muted");
    });

    it("arrow up wraps from first to last", async () => {
      const user = userEvent.setup();
      const { trigger } = renderCombobox();

      await user.click(trigger);
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveClass("bg-muted");

      await user.keyboard("{ArrowUp}");
      expect(options[options.length - 1]).toHaveClass("bg-muted");
      expect(options[0]).not.toHaveClass("bg-muted");
    });

    it("enter selects the active option", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <Combobox value="" onChange={onChange} items={FLAT_ITEMS}>
          <span>Open</span>
        </Combobox>
      );

      await user.click(screen.getByRole("button", { name: /open/i }));
      await user.keyboard("{ArrowDown}"); // move to "Banana" (index 1)
      await user.keyboard("{Enter}");

      expect(onChange).toHaveBeenCalledWith("banana");
    });

    it("escape closes the dropdown", async () => {
      const user = userEvent.setup();
      const { trigger } = renderCombobox();

      await user.click(trigger);
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("arrow keys work across groups", async () => {
      const user = userEvent.setup();
      const { trigger } = renderCombobox({ items: GROUPED_ITEMS });

      await user.click(trigger);
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(4);

      await user.keyboard("{ArrowDown}");
      expect(options[1]).toHaveClass("bg-muted"); // Banana
      await user.keyboard("{ArrowDown}");
      expect(options[2]).toHaveClass("bg-muted"); // Carrot (crosses group)
    });
  });

  describe("active index stability", () => {
    it("active index is not reset by parent re-renders", async () => {
      const user = userEvent.setup();
      let forceRerender: () => void;

      function Wrapper() {
        const [, setTick] = useState(0);
        forceRerender = () => setTick((t) => t + 1);
        const items = FLAT_ITEMS.map((item) => ({ ...item })); // new refs each render
        return (
          <Combobox value="" onChange={() => {}} items={items}>
            <span>Open</span>
          </Combobox>
        );
      }

      render(<Wrapper />);
      await user.click(screen.getByRole("button", { name: /open/i }));
      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowDown}");

      const options = screen.getAllByRole("option");
      expect(options[2]).toHaveClass("bg-muted"); // Cherry

      // Trigger a parent re-render without clicking outside (simulates SWR revalidation)
      act(() => forceRerender!());

      const optionsAfter = screen.getAllByRole("option");
      expect(optionsAfter[2]).toHaveClass("bg-muted"); // Still Cherry
      expect(optionsAfter[0]).not.toHaveClass("bg-muted");
    });

    it("mouse hover preserves active index", async () => {
      const user = userEvent.setup();
      const { trigger } = renderCombobox();

      await user.click(trigger);

      const options = screen.getAllByRole("option");
      await user.hover(options[3]);
      expect(options[3]).toHaveClass("bg-muted");
      expect(options[0]).not.toHaveClass("bg-muted");
    });
  });

  describe("search filtering", () => {
    it("typing resets active index to first filtered result", async () => {
      const user = userEvent.setup();
      const { trigger } = renderCombobox({ searchable: true });

      await user.click(trigger);
      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowDown}");

      const search = screen.getByRole("combobox");
      await user.type(search, "ban");

      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(1);
      expect(options[0]).toHaveClass("bg-muted");
    });

    it("sets active index to -1 when no results match", async () => {
      const user = userEvent.setup();
      const { trigger } = renderCombobox({ searchable: true });

      await user.click(trigger);
      const search = screen.getByRole("combobox");
      await user.type(search, "zzzzz");

      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(search).not.toHaveAttribute("aria-activedescendant");
    });
  });

  describe("opening behavior", () => {
    it("activates the selected value when opening", async () => {
      const user = userEvent.setup();
      render(
        <Combobox value="cherry" onChange={() => {}} items={FLAT_ITEMS}>
          <span>Open</span>
        </Combobox>
      );

      await user.click(screen.getByRole("button", { name: /open/i }));

      const options = screen.getAllByRole("option");
      expect(options[2]).toHaveClass("bg-muted");
      expect(options[0]).not.toHaveClass("bg-muted");
    });
  });
});
