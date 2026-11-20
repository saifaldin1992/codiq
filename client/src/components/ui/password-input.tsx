import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Eye, EyeOff } from "lucide-react";
import * as React from "react";

/**
 * P27-10 — a password field the person can actually read back (ق-98).
 *
 * Owner decision: every password field on the platform gets this, merchant and
 * staff and customer and owner alike. A field nobody can see is typed wrong and
 * retyped three times, and on a phone keyboard that is the most common reason a
 * sign-up is abandoned halfway.
 *
 * It lives in the component library, not beside one screen, because ق-06 says a
 * visual component is built once and used — six call sites today, and the seventh
 * must not be a seventh hand-rolled eye.
 *
 * Three details that are easy to get wrong and expensive to discover later:
 *
 * 1. `type="button"`. A bare <button> inside a <form> submits it, so the first
 *    person to reveal his password would instead post the form half-filled.
 * 2. Logical inset (`end-*`, `pe-*`), never `right-*`. The platform is RTL today
 *    and gains English in P27-9; a hard-coded side is a bug in one of the two.
 * 3. `::-ms-reveal` is hidden. Edge draws its OWN eye inside password inputs, so
 *    without this the merchant sees two of them and they disagree.
 *
 * FOURTH detail, learned the hard way: this control must NOT be nested inside
 * the field's <label>. A descendant's aria-label folds into the label's text
 * alternative, so the input would announce itself as «كلمة المرور إظهار كلمة
 * المرور» — and any label-based query would match two elements. Bind the label
 * with htmlFor/id and keep the toggle a sibling of the input, as every call
 * site in this repository now does.
 *
 * The value is never logged, never copied, and the toggle is local state that
 * resets on unmount — revealing is a glance, not a stored preference.
 */
export function PasswordInput({
  className,
  showLabel = "إظهار كلمة المرور",
  hideLabel = "إخفاء كلمة المرور",
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type"> & { showLabel?: string; hideLabel?: string }) {
  const [visible, setVisible] = React.useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={cn("pe-10 [&::-ms-reveal]:hidden [&::-ms-clear]:hidden", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        title={visible ? hideLabel : showLabel}
        className={cn(
          // المرحلة 21: the reveal icon rests muted and darkens on hover. The
          // two hand-picked greys it used sat a few points either side of this
          // token pair — and naming them here would have put them back, since
          // the guard counts a comment exactly as it counts a class. The tokens
          // are what a dark theme can move, and a password field that keeps a
          // light-mode grey in the dark is an invisible control on the one input
          // nobody can retype blind.
          "absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-md text-[var(--codiq-text-muted)]",
          "transition-colors hover:text-[var(--codiq-text-secondary)]",
          "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
        disabled={props.disabled}
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
