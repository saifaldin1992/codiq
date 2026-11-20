/**
 * codiq — motion primitives for the public marketing landing page.
 *
 * Hand-rolled on purpose: the repo carries no animation library and must not
 * gain one (phase-21 bundle discipline), so scroll reveals ride a single shared
 * IntersectionObserver and counters ride requestAnimationFrame.
 *
 * Accessibility contract: every hook resolves straight to its *finished* state
 * when the visitor asks for reduced motion, so nothing is ever left invisible
 * behind an animation that was told not to run.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

/** Stagger helper — feeds the `--cq-delay` custom property the CSS layer reads. */
export function delayStyle(milliseconds: number, base?: CSSProperties): CSSProperties {
  return { ...base, "--cq-delay": `${milliseconds}ms` } as CSSProperties;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}

/**
 * Imperative read for event handlers, where a hook cannot run — `scrollIntoView`
 * needs the answer at click time, not at render time.
 */
export function prefersReducedMotionNow(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

/**
 * `scrollIntoView({ behavior: "smooth" })` in JS OVERRIDES the CSS
 * `scroll-behavior: auto` that the reduced-motion block sets, so a visitor who
 * asked for less motion still got a 1.2s animated scroll. Every programmatic
 * scroll on the landing page goes through this instead.
 */
export function scrollBehaviour(): ScrollBehavior {
  return prefersReducedMotionNow() ? "auto" : "smooth";
}

/**
 * ONE `matchMedia` listener for the whole page instead of one per hook call.
 * Every `useReveal`/`useCountUp` used to open its own subscription — 57 of them
 * on this page — which is real work on a low-end Android device. React subscribes
 * each component to this single module-level store instead.
 */
const reducedMotionSubscribers = new Set<() => void>();
let reducedMotionListening = false;

function subscribeReducedMotion(onChange: () => void): () => void {
  reducedMotionSubscribers.add(onChange);
  const media = reducedMotionQuery();
  if (media && !reducedMotionListening) {
    reducedMotionListening = true;
    media.addEventListener("change", notifyReducedMotion);
  }
  return () => {
    reducedMotionSubscribers.delete(onChange);
  };
}

function notifyReducedMotion(): void {
  // `forEach` rather than for-of: this tsconfig targets ES5 and iterating a Set
  // directly would need --downlevelIteration.
  reducedMotionSubscribers.forEach((subscriber) => subscriber());
}

/** Live `prefers-reduced-motion` state — re-renders when the visitor flips the OS setting. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotionNow, () => false);
}

/**
 * Splits a browser-level network failure from a real application error.
 *
 * A rejected `fetch` is a `TypeError` whose message is the browser's own English
 * string ("Failed to fetch"), so `error instanceof Error ? error.message : …`
 * showed English to an Arabic-only audience and the Arabic fallback could never
 * fire — exactly the case that matters most on an intermittent Iraqi connection.
 * An application error, by contrast, is thrown by the caller with a translated
 * server message («رابط المتجر مستخدم بالفعل.») and must be shown as-is.
 */
export function describeFetchFailure(error: unknown): string {
  if (error instanceof TypeError) return "تعذّر الاتصال بالخادم. تحقق من اتصالك بالإنترنت ثم أعد المحاولة.";
  if (error instanceof Error && error.message.trim()) return error.message;
  return "خطأ غير متوقع.";
}

/**
 * One observer for the whole page instead of one per revealed block; each target
 * fires once and is dropped, so nothing keeps observing after it has been seen.
 */
const revealCallbacks = new WeakMap<Element, () => void>();
let revealObserver: IntersectionObserver | null = null;

function sharedRevealObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!revealObserver) {
    revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const run = revealCallbacks.get(entry.target);
          revealCallbacks.delete(entry.target);
          revealObserver?.unobserve(entry.target);
          run?.();
        }
      },
      // Threshold 0 keeps blocks taller than the viewport working; the bottom
      // margin delays the reveal until the block is genuinely in the reading area.
      { threshold: 0, rootMargin: "0px 0px -80px 0px" },
    );
  }
  return revealObserver;
}

/** Attach `ref` to a block; `revealed` flips true once it scrolls into view (immediately under reduced motion). */
export function useReveal<T extends Element>() {
  const ref = useRef<T | null>(null);
  const reduced = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (revealed) return;
    const node = ref.current;
    if (!node) return;
    const observer = reduced ? null : sharedRevealObserver();
    if (!observer) {
      setRevealed(true);
      return;
    }
    revealCallbacks.set(node, () => setRevealed(true));
    observer.observe(node);
    return () => {
      revealCallbacks.delete(node);
      observer.unobserve(node);
    };
  }, [reduced, revealed]);

  return { ref, revealed } as const;
}

/**
 * A second shared observer — this one does NOT unobserve, because it answers
 * "is this still on screen?" rather than "has this been seen once?".
 *
 * The page carries 44 infinite CSS animations (hero motif, the device fan, the
 * capability marquee). They kept burning compositor frames long after the
 * visitor scrolled past them, which is felt on a low-end Android. Attaching this
 * ref flips `data-cq-onscreen`, and index.css parks every animation inside an
 * off-screen block with `animation-play-state: paused`.
 *
 * It starts `true` so a block is never frozen mid-paint before the observer has
 * reported, and so environments without IntersectionObserver simply keep playing.
 */
const viewportCallbacks = new WeakMap<Element, (visible: boolean) => void>();
let viewportObserver: IntersectionObserver | null = null;

function sharedViewportObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!viewportObserver) {
    viewportObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) viewportCallbacks.get(entry.target)?.(entry.isIntersecting);
      },
      // A screen of slack on each side: the animation is already running by the
      // time the block scrolls in, so nothing visibly starts from a cold frame.
      { threshold: 0, rootMargin: "200px 0px" },
    );
  }
  return viewportObserver;
}

export function useInViewport<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = sharedViewportObserver();
    if (!observer) return;
    viewportCallbacks.set(node, setVisible);
    observer.observe(node);
    return () => {
      viewportCallbacks.delete(node);
      observer.unobserve(node);
    };
  }, []);

  return { ref, visible } as const;
}

/** Eases 0 → `target` on rAF once `active`; jumps straight to `target` under reduced motion. */
export function useCountUp(target: number, active: boolean, durationMs = 1100): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active) return;
    if (reduced || target === 0 || typeof requestAnimationFrame !== "function") {
      setValue(target);
      return;
    }
    let frame = 0;
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      setValue(progress >= 1 ? target : target * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, target, reduced, durationMs]);

  return value;
}

/**
 * Live media-query state, chosen at MOUNT instead of mounting twice and hiding
 * one copy with CSS. The hero used to render two DeviceShowcase instances (one
 * per breakpoint, one always `display:none`) — double the SVG nodes for zero
 * pixels. ق-137 made that pattern a budget question, not a style one: render
 * one structure and swap it when the query actually flips.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** True once the window has scrolled past `offset` — drives the sticky nav's elevated state. */
export function useScrolledPast(offset = 8): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > offset);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [offset]);
  return scrolled;
}
