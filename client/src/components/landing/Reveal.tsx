/**
 * codiq landing — scroll reveal wrapper.
 * Renders a plain element that starts translated/faded and settles once the
 * shared IntersectionObserver sees it. Under `prefers-reduced-motion: reduce`
 * the hook reports "revealed" on mount and `.cq-reveal` drops its transition,
 * so the content simply exists.
 */
import type { CSSProperties, ReactNode } from "react";
import { delayStyle, useReveal } from "@/lib/landing-motion";

type RevealTag = "div" | "section" | "li" | "p" | "header" | "footer";

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Stagger inside a group, in milliseconds. */
  delay?: number;
  as?: RevealTag;
  style?: CSSProperties;
  id?: string;
};

export function Reveal({ children, className = "", delay = 0, as: Tag = "div", style, id }: RevealProps) {
  const { ref, revealed } = useReveal<HTMLElement>();
  return (
    <Tag
      id={id}
      ref={ref as never}
      data-revealed={revealed ? "true" : "false"}
      style={delay ? delayStyle(delay, style) : style}
      className={`cq-reveal ${className}`}
    >
      {children}
    </Tag>
  );
}
