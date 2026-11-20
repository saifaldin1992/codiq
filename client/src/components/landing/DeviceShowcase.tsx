/**
 * codiq landing — the hero device showcase.
 *
 * A fan of phone frames drawn entirely as inline SVG (frame, screen, notch and
 * the mock UI inside it) — no screenshot, no raster asset, nothing that can
 * pixelate. Each frame cross-fades through the same four screens the storefront
 * really has (catalogue → cart → orders → COD checkout), offset so the fan
 * always shows four different states at once.
 *
 * The mock UI is deliberately typographic-free: bars and tiles, never fake
 * Arabic copy or invented numbers.
 *
 * Motion: one CSS keyframe per screen group. `.cq-screen[data-static="true"]`
 * carries the frame's first screen at full opacity, so when index.css cancels
 * the animation under `prefers-reduced-motion: reduce` every frame still shows
 * exactly one readable screen.
 */

const SCREEN_COUNT = 4;
/** Full cycle length; must match `cq-screen-cycle` in index.css. */
const CYCLE_SECONDS = 13.2;
const STEP_SECONDS = CYCLE_SECONDS / SCREEN_COUNT;

const BLUE = "#1E6FDB";
const TILE = "#EDF3FD";
const LINE = "#DCE6F5";
const FAINT = "#EEF2F8";
const EDGE = "#E7EEF9";

/** Placement of each frame in the fan, per requested frame count. */
const LAYOUTS: Record<number, { x: number; y: number; rotate: number; scale: number }[]> = {
  2: [
    { x: 26, y: 44, rotate: -6, scale: 0.9 },
    { x: 196, y: 14, rotate: 0, scale: 1 },
  ],
  4: [
    { x: 0, y: 46, rotate: -7, scale: 0.86 },
    { x: 72, y: 30, rotate: -4.5, scale: 0.9 },
    { x: 148, y: 16, rotate: -2, scale: 0.95 },
    { x: 226, y: 4, rotate: 0, scale: 1 },
  ],
};

function bar(x: number, y: number, width: number, height = 6, fill = LINE) {
  return <rect key={`${x}-${y}-${width}`} x={x} y={y} width={width} height={height} rx={height / 2} fill={fill} />;
}

/** Shared chrome every screen sits under. */
function ScreenHeader() {
  return (
    <g>
      {bar(12, 14, 56, 8, "#C9D8EE")}
      <rect x={118} y={10} width={22} height={16} rx={8} fill={TILE} />
    </g>
  );
}

/** 0 — catalogue: a two-column product grid. */
function CatalogueScreen() {
  return (
    <g>
      <ScreenHeader />
      <rect x={12} y={34} width={128} height={18} rx={9} fill="#F3F7FC" />
      {bar(22, 41, 46, 5, "#CFDCEE")}
      {[0, 1, 2].map((row) =>
        [0, 1].map((column) => {
          const x = 12 + column * 68;
          const y = 62 + row * 78;
          return (
            <g key={`${row}-${column}`}>
              <rect x={x} y={y} width={60} height={50} rx={11} fill={TILE} />
              <circle cx={x + 30} cy={y + 25} r={11} fill="#DCE8FA" />
              {bar(x, y + 56, 42, 5)}
              {bar(x, y + 65, 26, 5, "#E6ECF5")}
            </g>
          );
        }),
      )}
      <rect x={12} y={298} width={128} height={16} rx={8} fill={FAINT} />
    </g>
  );
}

/** 1 — cart: line items, a totals block and the primary action. */
function CartScreen() {
  return (
    <g>
      <ScreenHeader />
      {[0, 1, 2].map((row) => {
        const y = 42 + row * 50;
        return (
          <g key={row}>
            <rect x={12} y={y} width={38} height={38} rx={10} fill={TILE} />
            {bar(58, y + 8, 62)}
            {bar(58, y + 22, 38, 5, "#E6ECF5")}
          </g>
        );
      })}
      <rect x={12} y={200} width={128} height={58} rx={13} fill="#F6F9FD" />
      {bar(24, 214, 52, 5, "#CFDCEE")}
      {bar(104, 214, 24, 5, "#CFDCEE")}
      {bar(24, 232, 40, 5, "#DFE7F2")}
      {bar(108, 232, 20, 5, "#DFE7F2")}
      <rect x={12} y={272} width={128} height={22} rx={11} fill={BLUE} />
    </g>
  );
}

/** 2 — orders: rows carrying the real status palette from the dashboard. */
function OrdersScreen() {
  const pills = ["#CFE1FA", "#F6DFB6", "#DDD3F4", "#C6E6D3"];
  return (
    <g>
      <ScreenHeader />
      {pills.map((pill, row) => {
        const y = 42 + row * 54;
        return (
          <g key={pill}>
            <rect x={12} y={y} width={128} height={44} rx={11} fill="#FFFFFF" stroke={EDGE} strokeWidth={1} />
            {bar(24, y + 13, 46, 5, "#C9D8EE")}
            {bar(24, y + 26, 30, 5, "#E1E8F3")}
            <rect x={96} y={y + 15} width={32} height={13} rx={6.5} fill={pill} />
          </g>
        );
      })}
      <rect x={12} y={266} width={128} height={28} rx={11} fill="#F6F9FD" />
      {[0, 1, 2, 3, 4].map((index) => (
        <rect key={index} x={22 + index * 22} y={286 - index * 3 - 4} width={10} height={index * 3 + 8} rx={3} fill="#CBDDF6" />
      ))}
    </g>
  );
}

/** 3 — checkout: address fields, the COD row, and confirm. */
function CheckoutScreen() {
  return (
    <g>
      <ScreenHeader />
      {[0, 1, 2].map((row) => {
        const y = 44 + row * 34;
        return (
          <g key={row}>
            <rect x={12} y={y} width={128} height={26} rx={9} fill="#FFFFFF" stroke={EDGE} strokeWidth={1} />
            {bar(24, y + 10, 54, 5, "#DCE4F0")}
          </g>
        );
      })}
      <rect x={12} y={156} width={128} height={40} rx={12} fill="#EAF2FF" stroke="#D3E2F9" strokeWidth={1} />
      <circle cx={34} cy={176} r={11} fill="#FFFFFF" stroke={BLUE} strokeWidth={1.6} />
      <circle cx={34} cy={176} r={4} fill={BLUE} />
      {bar(54, 168, 56, 5, "#A9C7EE")}
      {bar(54, 180, 34, 5, "#C6D9F2")}
      {bar(24, 214, 48, 5, "#DFE7F2")}
      {bar(104, 214, 24, 5, "#DFE7F2")}
      {bar(24, 232, 40, 5, "#DFE7F2")}
      {bar(104, 232, 24, 5, "#DFE7F2")}
      <rect x={12} y={258} width={128} height={22} rx={11} fill={BLUE} />
      <rect x={12} y={290} width={128} height={16} rx={8} fill={FAINT} />
    </g>
  );
}

const SCREENS = [CatalogueScreen, CartScreen, OrdersScreen, CheckoutScreen];

function PhoneFrame({ index }: { index: number }) {
  const first = index % SCREEN_COUNT;
  return (
    <g className="cq-device__float" style={{ animationDelay: `${index * -1.7}s` }}>
      <rect x={0} y={0} width={168} height={340} rx={27} fill="#FFFFFF" stroke="#DEE7F3" strokeWidth={1.5} />
      <rect x={5} y={5} width={158} height={330} rx={23} fill="none" stroke="#F1F5FB" strokeWidth={1} />
      <rect x={8} y={8} width={152} height={324} rx={20} fill="#FBFCFE" />
      <g className="cq-device__screens" transform="translate(8 8)">
        {SCREENS.map((Screen, screenIndex) => {
          const offset = (((screenIndex - first) % SCREEN_COUNT) + SCREEN_COUNT) % SCREEN_COUNT;
          const delay = offset === 0 ? 0 : -(SCREEN_COUNT - offset) * STEP_SECONDS;
          return (
            <g
              key={screenIndex}
              className="cq-screen"
              data-static={screenIndex === first ? "true" : undefined}
              style={{ animationDelay: `${delay}s` }}
            >
              <Screen />
            </g>
          );
        })}
      </g>
      <rect x={62} y={14} width={44} height={6} rx={3} fill="#E4EAF4" />
      <rect x={62} y={322} width={44} height={4} rx={2} fill="#E4EAF4" />
    </g>
  );
}

export function DeviceShowcase({ frames, className = "" }: { frames: 2 | 4; className?: string }) {
  const layout = LAYOUTS[frames];
  return (
    <svg viewBox="0 0 400 410" className={className} aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id={`cq-device-glow-${frames}`} cx="0.5" cy="0.45" r="0.55">
          <stop offset="0" stopColor="var(--codiq-accent)" stopOpacity="0.13" />
          <stop offset="1" stopColor="var(--codiq-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="200" cy="205" rx="200" ry="185" fill={`url(#cq-device-glow-${frames})`} />
      {layout.map((placement, index) => (
        <g key={index} transform={`translate(${placement.x} ${placement.y}) rotate(${placement.rotate} 84 170) scale(${placement.scale})`}>
          <PhoneFrame index={index} />
        </g>
      ))}
    </svg>
  );
}
