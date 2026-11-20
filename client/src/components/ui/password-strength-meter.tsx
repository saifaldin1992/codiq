import * as React from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { assessPassword, type PasswordAssessment, type StrengthLevel } from "@/lib/password-strength";

/**
 * The strength bar under a password field (owner request, 2026-08-31).
 *
 * Built once, in the component library, like `PasswordInput` beside it — ق-06.
 * Every place a password is CHOSEN gets this; the sign-in field does not, since
 * there is nothing to advise about a password you already have.
 *
 * ============================================================================
 * WHAT IT SAYS, AND WHAT IT REFUSES TO SAY
 * ============================================================================
 *
 * It never reads «قوية» about something the server will refuse — the assessment
 * checks acceptance first, and rejection dominates the score. A bar that fills
 * green and is then contradicted by a red server error is worse than no bar,
 * because the person now distrusts both.
 *
 * The list below the bar is written as things to DO, not rules that were
 * broken, and it distinguishes the two REQUIRED rules from the two suggestions.
 * A person who has met both requirements sees a usable password, not a wall of
 * red — the suggestions say what would make it stronger, and ignoring them is
 * allowed. That is the owner's decision made visible: no composition rules.
 *
 * ============================================================================
 * ACCESSIBILITY
 * ============================================================================
 *
 * The bar is decorative and hidden from assistive tech; the SAME information is
 * announced through a polite live region carrying the strength name and the
 * refusal reason. Announcing on every keystroke would be unusable, so only the
 * level NAME lands in the region — it changes a handful of times, not once per
 * character.
 *
 * Colour is never the only signal: every state carries a word, and every item
 * in the list carries a tick or a cross as well as its colour. A meter that
 * distinguishes «weak» from «strong» by hue alone says nothing to a person who
 * cannot separate red from green.
 */

/**
 * Each level owns a token pair. No raw hex — the palette is the design system's.
 *
 * RED MEANS EXACTLY ONE THING: this will be refused. A weak-but-usable password
 * is amber, not red. Painting both the same colour was the first version, and it
 * left the bar unable to answer the only question the person is actually asking —
 * «can I press the button?» — since «غير مقبولة» and «ضعيفة» drew identically.
 */
const LEVEL_STYLE: Record<StrengthLevel, { fill: string; text: string }> = {
  0: { fill: "bg-[var(--codiq-danger)]", text: "text-[var(--codiq-danger)]" },
  1: { fill: "bg-[var(--codiq-warning)]", text: "text-[var(--codiq-warning)]" },
  2: { fill: "bg-[var(--codiq-warning)]", text: "text-[var(--codiq-warning)]" },
  3: { fill: "bg-[var(--codiq-success)]", text: "text-[var(--codiq-success)]" },
  4: { fill: "bg-[var(--codiq-success)]", text: "text-[var(--codiq-success)]" },
};

const SEGMENTS = 4;

export interface PasswordStrengthMeterProps {
  /** The live value of the field this sits under. */
  value: string;
  /**
   * Ties the meter to its input for assistive tech. Pass the input's
   * `aria-describedby` the same id.
   */
  id?: string;
  className?: string;
  /**
   * Hide the guidance list until the person starts typing. Off by default: the
   * rules are most useful BEFORE he invents a password, not after he is told his
   * is wrong.
   */
  hideChecksUntilTyping?: boolean;
}

export function PasswordStrengthMeter({
  value,
  id,
  className,
  hideChecksUntilTyping = false,
}: PasswordStrengthMeterProps) {
  const assessment: PasswordAssessment = React.useMemo(() => assessPassword(value), [value]);
  const style = LEVEL_STYLE[assessment.level];
  const filled = assessment.empty ? 0 : assessment.accepted ? assessment.level : 1;
  const showChecks = !hideChecksUntilTyping || !assessment.empty;

  return (
    <div id={id} className={cn("space-y-2", className)} data-testid="password-strength">
      {/* The bar. Decorative — the live region below carries the same meaning. */}
      <div className="flex items-center gap-2" aria-hidden="true">
        <div className="flex h-1.5 flex-1 gap-1">
          {Array.from({ length: SEGMENTS }, (_, index) => (
            <div
              key={index}
              className={cn(
                "h-full flex-1 rounded-full transition-colors duration-200",
                index < filled ? style.fill : "bg-[var(--codiq-border)]",
              )}
            />
          ))}
        </div>
        {!assessment.empty && (
          <span className={cn("shrink-0 text-xs font-semibold tabular-nums", style.text)}>{assessment.label}</span>
        )}
      </div>

      {/* The same thing, for a screen reader. Polite, so it waits its turn. */}
      {/* `aria-live="polite"` WITHOUT `role="status"`. The role implies exactly
          this live behaviour, so it buys nothing here — and it adds a second
          `status` role to pages that already have one, which broke a browser
          test querying `getByRole("status")` in strict mode. Announcing is the
          goal; claiming a landmark is not. */}
      <p className="sr-only" aria-live="polite" data-testid="password-strength-announcement">
        {assessment.empty ? "" : `قوة كلمة المرور: ${assessment.label}.${assessment.reason ? ` ${assessment.reason}` : ""}`}
      </p>

      {/* The reason, when the server would refuse it — said once, in place. */}
      {assessment.reason && (
        <p className="text-xs font-medium text-[var(--codiq-danger)]" data-testid="password-strength-reason">
          {assessment.reason}
        </p>
      )}

      {showChecks && (
        <ul className="space-y-1" data-testid="password-strength-checks">
          {assessment.checks.map((check) => (
            <li
              key={check.id}
              className={cn(
                "flex items-center gap-1.5 text-xs",
                check.met
                  ? "text-[var(--codiq-success)]"
                  : check.required
                    ? "text-[var(--codiq-text-secondary)]"
                    : "text-[var(--codiq-text-muted)]",
              )}
            >
              {check.met ? (
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <X className="size-3.5 shrink-0 opacity-40" aria-hidden="true" />
              )}
              <span>
                {check.label}
                {/* Says plainly which two are rules and which two are advice, so
                    nobody thinks he must satisfy all four. */}
                {!check.required && <span className="text-[var(--codiq-text-muted)]"> — اختياري</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-[var(--codiq-text-muted)]">
        نصيحة: عبارة قصيرة تتذكرها أنت وحدك — مثل «شجرة الرمان في بيت جدي» — أقوى من كلمة قصيرة معقّدة، وأسهل في التذكّر.
      </p>
    </div>
  );
}
