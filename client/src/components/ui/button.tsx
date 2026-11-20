import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * HeroUI skin (owner directive 2026-09-02, «استخدمها كلها»): the platform's
 * button grammar follows the HeroUI reference — FULL-PILL radius, semibold
 * label, a soft accent-tinted focus ring, a press scale on the pointer, and
 * tinted SOFT variants for every semantic colour — executed entirely in
 * CODIQ tokens with zero new dependencies (ق-137 stands). Call sites that
 * pass their own radius/padding keep winning through tailwind-merge, so the
 * skin lands screen by screen without breaking any bespoke composition.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-4 focus-visible:ring-[var(--codiq-accent-soft)] focus-visible:border-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_6px_16px_color-mix(in_srgb,var(--codiq-accent)_28%,transparent)]",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        // HeroUI's soft-danger: the tinted refusal that doesn't shout.
        "destructive-soft":
          "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]/80 focus-visible:ring-destructive/20",
        outline:
          "border border-[var(--codiq-border-strong)] bg-transparent hover:bg-[var(--codiq-neutral-soft)] dark:bg-transparent dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)] hover:bg-[var(--codiq-accent-soft)]/80",
        // HeroUI's tertiary: the quiet neutral fill.
        tertiary:
          "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text)] hover:bg-[var(--codiq-neutral-soft)]/80",
        ghost:
          "text-[var(--codiq-text-secondary)] hover:bg-[var(--codiq-neutral-soft)] dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-10 px-6 py-2 has-[>svg]:px-5",
        sm: "h-9 gap-1.5 px-4 has-[>svg]:px-3.5",
        lg: "h-12 px-8 text-base has-[>svg]:px-6",
        icon: "size-10",
        "icon-sm": "size-9",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
