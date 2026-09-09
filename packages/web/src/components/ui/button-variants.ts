import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-foreground hover:bg-accent/90",
        outline: "border border-border text-foreground hover:bg-muted",
        ghost: "text-muted-foreground hover:text-foreground hover:bg-muted",
        destructive: "text-destructive hover:text-destructive hover:bg-destructive-muted",
        subtle: "text-secondary-foreground hover:text-foreground disabled:opacity-30",
      },
      size: {
        default: "px-4 py-2 text-sm",
        sm: "px-3 py-1.5 text-sm",
        xs: "px-2 py-1 text-xs",
        icon: "p-1.5",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
);
