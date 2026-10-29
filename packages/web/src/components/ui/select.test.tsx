// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { useState, type ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

expect.extend(matchers);
afterEach(cleanup);

function ExampleSelect(props: ComponentProps<typeof Select>) {
  return (
    <Select defaultValue="alpha" {...props}>
      <SelectTrigger aria-label="Choice">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="alpha">Alpha</SelectItem>
        <SelectItem value="beta" disabled>
          Beta
        </SelectItem>
        <SelectItem value="gamma" disabled={false}>
          Gamma
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("Select", () => {
  it("propagates root disablement without losing item-specific restrictions", () => {
    const view = (disabled: boolean) => (
      <form>
        <ExampleSelect disabled={disabled} />
      </form>
    );
    const { container, rerender } = render(view(true));
    // Radix retains native form options even when the portaled listbox is closed.
    const disabledOptions = () =>
      ["alpha", "beta", "gamma"].map(
        (value) => container.querySelector<HTMLOptionElement>(`option[value="${value}"]`)?.disabled
      );
    expect(disabledOptions()).toEqual([true, true, true]);
    expect(screen.getByRole("combobox", { name: "Choice" })).toBeDisabled();

    rerender(view(false));
    expect(disabledOptions()).toEqual([false, true, false]);
    expect(screen.getByRole("combobox", { name: "Choice" })).toBeEnabled();
  });

  it.each([false, true])(
    "closes an uncontrolled menu on disablement (defaultOpen=%s) and does not reopen on enablement",
    async (defaultOpen) => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      const onValueChange = vi.fn();
      const props = { defaultOpen, onOpenChange, onValueChange };
      const { rerender } = render(<ExampleSelect {...props} />);
      if (!defaultOpen) await user.click(screen.getByLabelText("Choice"));
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      rerender(<ExampleSelect {...props} disabled />);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Choice")).toBeDisabled();
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      expect(onValueChange).not.toHaveBeenCalled();

      rerender(<ExampleSelect {...props} />);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      await user.click(screen.getByLabelText("Choice"));
      expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute("aria-disabled", "true");
      await user.click(screen.getByRole("option", { name: "Gamma" }));
      expect(onValueChange).toHaveBeenCalledWith("gamma");
      expect(screen.getByLabelText("Choice")).toHaveTextContent("Gamma");
      await waitFor(() => expect(screen.getByLabelText("Choice")).toHaveFocus());
    }
  );

  it("notifies a controlled caller when disablement closes its menu", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    function ControlledSelect({ disabled }: { disabled: boolean }) {
      const [open, setOpen] = useState(false);
      return (
        <ExampleSelect
          disabled={disabled}
          open={open}
          onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            setOpen(nextOpen);
          }}
        />
      );
    }
    const { rerender } = render(<ControlledSelect disabled={false} />);
    await user.click(screen.getByLabelText("Choice"));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    rerender(<ControlledSelect disabled />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    rerender(<ControlledSelect disabled={false} />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Choice"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("keeps a disabled root closed even when the caller requests it open", async () => {
    const onOpenChange = vi.fn();
    render(<ExampleSelect disabled open onOpenChange={onOpenChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Choice"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});
