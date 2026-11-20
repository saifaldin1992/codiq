import * as React from "react";
import { PasswordInput } from "@/components/ui/password-input";
import { PasswordStrengthMeter } from "@/components/ui/password-strength-meter";

/**
 * A password field that is being CHOSEN, with the strength bar under it.
 *
 * Exists as its own component for one practical reason: every form on this
 * platform is uncontrolled and reads its values with `FormData`, while a meter
 * needs the value on every keystroke. Rather than convert three forms to
 * controlled state — and give three screens a new way to go wrong — the state
 * lives HERE, local to the field, and the input stays a real named input so
 * `FormData` keeps working untouched.
 *
 * That makes each call site a one-word change: `PasswordInput` becomes
 * `PasswordInputWithMeter`. The label, the layout and the validation attributes
 * at each site stay exactly as they were.
 *
 * USE THIS WHERE A PASSWORD IS CHOSEN — sign-up, a staff seat, a change. NOT on
 * a sign-in field: there is nothing to advise about a password somebody already
 * has, and scoring it there would tell an onlooker how good it is.
 */
export function PasswordInputWithMeter({
  onChange,
  "aria-describedby": describedBy,
  ...props
}: React.ComponentProps<typeof PasswordInput>) {
  const [value, setValue] = React.useState("");
  const generatedId = React.useId();
  const meterId = `${props.id ?? generatedId}-strength`;

  return (
    <>
      <PasswordInput
        {...props}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          // Chained, never replaced: a call site that wants the value too must
          // keep getting it.
          onChange?.(event);
        }}
        aria-describedby={[describedBy, meterId].filter(Boolean).join(" ")}
      />
      <PasswordStrengthMeter value={value} id={meterId} />
    </>
  );
}
