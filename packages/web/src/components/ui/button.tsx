import * as React from "react";

import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

import type { VariantProps } from "class-variance-authority";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-semibold leading-normal ring-offset-white transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ash-900 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-ash-900 text-ash-100 hover:bg-ash-900/90 rounded-full",
        light: "border border-ash-200 bg-white text-black rounded-full",
        dark: "bg-black text-ash-200 rounded-full",
        destructive: "bg-lava-500 text-white hover:bg-lava-600 rounded-full",
        outline: "border border-ash-300 bg-white hover:bg-ash-100 hover:text-ash-900 rounded-full",
        secondary: "bg-ash-100 text-ash-900 hover:bg-ash-100/80 rounded-full",
        ghost: "hover:bg-ash-100 hover:text-ash-900",
        link: "text-ash-900 underline-offset-4 hover:underline",
        "rebolt-default":
          "inline-flex whitespace-nowrap rounded-full bg-white text-base font-semibold leading-6 tracking-tight text-ash-500 transition-all duration-200 ease-in-out",
        "rebolt-destructive":
          "inline-flex whitespace-nowrap rounded-full bg-lava-500 text-base font-semibold leading-6 tracking-tight text-white transition-all duration-200 ease-in-out hover:bg-lava-600",
        "rebolt-primary":
          "inline-flex whitespace-nowrap rounded-full bg-rebolt-500 text-base font-semibold leading-6 tracking-tight text-white transition-all duration-200 ease-in-out hover:bg-rebolt-400",
        "rebolt-secondary":
          "inline-flex whitespace-nowrap rounded-full bg-ash-900 text-base font-semibold leading-6 tracking-tight text-white transition-all duration-200 ease-in-out hover:bg-ash-800",
        "rebolt-tertiary":
          "inline-flex whitespace-nowrap rounded-full border border-rebolt-500 bg-transparent text-base font-semibold leading-6 text-rebolt-500 transition-all duration-500 ease-in-out hover:bg-rebolt-500 hover:text-white",
        "rebolt-outline":
          "inline-flex whitespace-nowrap rounded-full bg-white text-base font-semibold leading-6 tracking-tight text-ash-700 transition-all duration-200 ease-in-out border border-ash-300 hover:bg-ash-100 hover:text-ash-900",
        "rebolt-link":
          "inline-flex bg-transparent text-base font-semibold underline-offset-4 text-ash-700 hover:text-ash-900 underline tracking-tight",
        "rebolt-minimal": "bg-transparent text-ash-900 hover:bg-ash-200 rounded-md font-medium justify-between",
        ai: "bg-white text-ash-900 border border-transparent bg-origin-border [background-clip:padding-box,border-box] bg-[image:linear-gradient(white,white),linear-gradient(to_right,#6366f1,#a855f7,#ec4899)] hover:bg-[image:linear-gradient(#f8fafc,#f8fafc),linear-gradient(to_right,#6366f1,#a855f7,#ec4899)] rounded-full [&_svg]:text-[#6366f1]",
      },
      size: {
        onboarding: "px-4 py-3",
        md: "h-10 px-6 py-2",
        sm: "h-9 px-6 py-2 text-sm",
        xs: "h-8 px-3 text-xs py-2",
        lg: "h-11 px-8 py-3",
        xl: "h-12 px-6 text-base py-3",
        minimal: "px-2 py-1",
        icon: "size-10",
        link: "px-0 py-0",
      },
      iconPosition: {
        start: "pl-5 pr-6 gap-2",
        end: "pl-6 pr-5 gap-2",
        none: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "sm",
      iconPosition: "none",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  startIcon?: React.ReactNode;
  endIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, startIcon, endIcon, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const iconPosition = startIcon ? "start" : endIcon ? "end" : "none";

    if (iconPosition !== "none") {
      return (
        <Comp className={cn(buttonVariants({ variant, size, iconPosition }), className)} ref={ref} {...props}>
          <span className="flex items-center gap-2">
            {startIcon && startIcon}
            {props.children}
            {endIcon && endIcon}
          </span>
        </Comp>
      );
    }

    return (
      <Comp className={cn(buttonVariants({ variant, size, iconPosition }), className)} ref={ref} {...props}>
        {props.children}
      </Comp>
    );
  }
);

Button.displayName = "Button";

export { Button, buttonVariants };
