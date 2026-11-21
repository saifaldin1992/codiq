/**
 * codiq landing — the hero motif.
 *
 * A vector-only, brand-derived diagram of the COD loop the platform actually
 * runs: store → order → delivery → cash collected → back to the store. Built
 * from the BrandMark geometry (the open "C" with the coin in its gap) so the
 * hero is the logo, breathing, rather than an illustration. No raster asset,
 * no decorative imagery — phase-21 «اللغة البصرية الصافية».
 *
 * Motion is CSS-only and lives entirely in `.cq-motif-*` classes, which the
 * scoped `prefers-reduced-motion: reduce` block in index.css switches off; the
 * whole composition is `aria-hidden` because it repeats the copy beside it.
 */
import { Banknote, ShoppingBag, Store, Truck } from "lucide-react";

/** Four stops on the ring, in the order the travelling pulse visits them. */
const NODES = [
  { x: 344, y: 210, Icon: Store, step: 0 },
  { x: 210, y: 76, Icon: ShoppingBag, step: 1 },
  { x: 76, y: 210, Icon: Truck, step: 2 },
  { x: 210, y: 344, Icon: Banknote, step: 3 },
] as const;

export function HeroMotif({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 420 420"
      className={`cq-motif ${className}`}
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="cq-motif-pulse" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5AA0FF" />
          <stop offset="1" stopColor="var(--codiq-accent)" />
        </linearGradient>
        <radialGradient id="cq-motif-halo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="var(--codiq-accent)" stopOpacity="0.14" />
          <stop offset="1" stopColor="var(--codiq-accent)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cq-motif-core" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2E86F5" />
          <stop offset="1" stopColor="#1657C4" />
        </linearGradient>
        <pattern id="cq-motif-dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="1.4" cy="1.4" r="1.4" fill="var(--codiq-accent)" fillOpacity="0.08" />
        </pattern>
      </defs>

      <rect width="420" height="420" fill="url(#cq-motif-dots)" />
      <circle cx="210" cy="210" r="150" fill="url(#cq-motif-halo)" className="cq-motif-halo" />

      {/* Rings: the outer dashed one drifts, the rest hold the composition still. */}
      <g fill="none">
        <circle
          cx="210"
          cy="210"
          r="178"
          stroke="#E4EBF6"
          strokeWidth="1"
          strokeDasharray="2 9"
          className="cq-motif-drift"
        />
        <circle cx="210" cy="210" r="134" stroke="#DCE6F5" strokeWidth="1.5" />
        <circle cx="210" cy="210" r="88" stroke="#EAF0F9" strokeWidth="1" />
      </g>

      {/* The order travelling the loop: one short arc chasing the ring forever. */}
      <circle
        cx="210"
        cy="210"
        r="134"
        fill="none"
        stroke="url(#cq-motif-pulse)"
        strokeWidth="3"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="13 87"
        className="cq-motif-pulse"
      />

      {/* The outer <g> owns the placement transform; the inner one owns the CSS
          animation, because a CSS transform would otherwise replace the attribute. */}
      {NODES.map(({ x, y, Icon, step }) => (
        <g key={step} transform={`translate(${x} ${y})`}>
          <g className={`cq-motif-node cq-motif-node--${step}`}>
            <rect
              className="cq-motif-node__ring"
              x="-33"
              y="-33"
              width="66"
              height="66"
              rx="22"
              fill="none"
              stroke="var(--codiq-accent)"
              strokeWidth="1.5"
            />
            <rect
              x="-26"
              y="-26"
              width="52"
              height="52"
              rx="17"
              fill="#FFFFFF"
              stroke="#E1E9F5"
              strokeWidth="1.25"
            />
            <g transform="translate(-11 -11)">
              <Icon size={22} strokeWidth={1.7} color="var(--codiq-accent)" />
            </g>
          </g>
        </g>
      ))}

      {/* Core: the BrandMark geometry, enlarged — the C and its coin. */}
      <g className="cq-motif-core">
        <circle cx="210" cy="210" r="60" fill="#FFFFFF" stroke="#E4EBF6" strokeWidth="1.25" />
        <g transform="translate(210 210) scale(2.05) translate(-24 -24)">
          <path
            d="M31.5 16.4a10.6 10.6 0 1 0 0 15.2"
            fill="none"
            stroke="url(#cq-motif-core)"
            strokeWidth="4.4"
            strokeLinecap="round"
          />
          <circle cx="30.4" cy="24" r="3.15" fill="var(--codiq-accent)" className="cq-motif-coin" />
        </g>
      </g>
    </svg>
  );
}
