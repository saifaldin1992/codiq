/**
 * codiq landing — the showcase panels.
 *
 * Two inline-SVG diagrams for the alternating "what you actually get" rows: the
 * customer-facing storefront and the staff-permission surface. Both are schematic
 * on purpose — bars and tiles, no invented copy, no screenshot, no raster asset.
 *
 * `active` is fed by the section's scroll reveal: the storefront tiles fade up in
 * sequence and the permission toggles slide on one after another. index.css
 * cancels both under `prefers-reduced-motion: reduce`, leaving the finished
 * diagram (tiles visible, toggles already switched).
 */

import { delayStyle } from "@/lib/landing-motion";

const BLUE = "#1E6FDB";
const EDGE = "#E7EEF9";
const TILE = "#EDF3FD";

/** The customer's view: catalogue tiles under a store header, COD marked. */
export function StorefrontPanel({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 520 330"
      data-active={active ? "true" : "false"}
      className="cq-panel h-auto w-full"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="1"
        y="1"
        width="518"
        height="328"
        rx="22"
        fill="#FFFFFF"
        stroke="#E2EAF5"
        strokeWidth="1.5"
      />
      {/* Window chrome — dots on the right, the store's own address pill beside them. */}
      <path d="M1 45h518" stroke="#EEF2F8" strokeWidth="1.5" />
      {[496, 478, 460].map((cx) => (
        <circle key={cx} cx={cx} cy="23" r="4" fill="#E1E8F3" />
      ))}
      <rect x="150" y="14" width="290" height="18" rx="9" fill="#F4F7FB" />
      <rect x="286" y="20" width="140" height="6" rx="3" fill="#D8E2F0" />

      {/* Store header band. */}
      <rect x="24" y="64" width="472" height="66" rx="14" fill="#EAF2FF" />
      <rect x="384" y="82" width="96" height="10" rx="5" fill="#B9D2F4" />
      <rect x="418" y="102" width="62" height="8" rx="4" fill="#CBDDF6" />
      <rect x="40" y="84" width="86" height="26" rx="13" fill="#FFFFFF" />
      <circle cx="59" cy="97" r="7" fill={BLUE} />
      <rect x="72" y="94" width="42" height="6" rx="3" fill="#C6D9F2" />

      {/* Catalogue tiles — staggered in on reveal. */}
      {[0, 1, 2, 3].map((column) => {
        const x = 24 + column * 122;
        return (
          <g key={column} className="cq-panel__tile" style={delayStyle(column * 110)}>
            <rect x={x} y="150" width="110" height="86" rx="14" fill={TILE} />
            <circle cx={x + 55} cy="188" r="20" fill="#DCE8FA" />
            <rect x={x} y="246" width="76" height="8" rx="4" fill="#D5DFEE" />
            <rect x={x} y="262" width="48" height="8" rx="4" fill="#E4EAF4" />
          </g>
        );
      })}

      {/* COD marker — the one thing the storefront is built around. */}
      <g className="cq-panel__badge">
        <rect
          x="24"
          y="286"
          width="176"
          height="28"
          rx="14"
          fill="#FFFFFF"
          stroke="#D3E2F9"
          strokeWidth="1.5"
        />
        <circle cx="182" cy="300" r="8" fill="none" stroke={BLUE} strokeWidth="1.6" />
        <circle cx="182" cy="300" r="3" fill={BLUE} />
        <rect x="48" y="296" width="118" height="8" rx="4" fill="#BED5F3" />
      </g>
    </svg>
  );
}

/** The merchant's view: staff rows with per-permission switches the server enforces. */
export function PermissionsPanel({ active }: { active: boolean }) {
  const rows = [true, true, false, true, false, true];
  return (
    <svg
      viewBox="0 0 520 330"
      data-active={active ? "true" : "false"}
      className="cq-panel h-auto w-full"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="1"
        y="1"
        width="518"
        height="328"
        rx="22"
        fill="#FFFFFF"
        stroke="#E2EAF5"
        strokeWidth="1.5"
      />
      <rect x="24" y="24" width="130" height="12" rx="6" fill="#C9D8EE" />
      <rect x="382" y="20" width="60" height="20" rx="10" fill="#EAF2FF" />
      <rect x="450" y="20" width="46" height="20" rx="10" fill="#F4F7FB" />

      {rows.map((on, index) => {
        const y = 58 + index * 44;
        return (
          <g key={index} className="cq-panel__row" style={delayStyle(index * 90)}>
            <rect
              x="24"
              y={y}
              width="472"
              height="34"
              rx="12"
              fill="#FFFFFF"
              stroke={EDGE}
              strokeWidth="1.25"
            />
            <rect x="42" y={y + 13} width={124 - index * 9} height="8" rx="4" fill="#D5DFEE" />
            <rect x="248" y={y + 13} width={68} height="8" rx="4" fill="#E4EAF4" />
            <g className="cq-toggle" data-on={on ? "true" : "false"}>
              <rect
                className="cq-toggle__track"
                x="422"
                y={y + 8}
                width="52"
                height="18"
                rx="9"
                fill="#E1E8F3"
              />
              <circle
                className="cq-toggle__knob"
                cx="466"
                cy={y + 17}
                r="7"
                fill="#FFFFFF"
                stroke="#D6DFEC"
                strokeWidth="1"
              />
            </g>
          </g>
        );
      })}

      <rect x="24" y="300" width="180" height="8" rx="4" fill="#E4EAF4" />
    </svg>
  );
}
