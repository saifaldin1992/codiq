import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * المرحلة 20-2 — the one «تحميل المزيد» control.
 *
 * Every list on the platform now answers with a page and an opaque `nextCursor`,
 * so every screen that shows a list needs the same three things: a button when
 * there is more, a spinner while the next page is in flight, and nothing at all
 * when the list has ended. Five screens had already written that by hand, each
 * slightly differently; the remaining ten would have written it a sixth way.
 *
 * `cursor === null` renders NOTHING — deliberately. A permanently visible but
 * disabled «تحميل المزيد» reads as a broken button, not as the end of a list.
 */
/**
 * The dashboards and the storefront carry two different token sets
 * (`--codiq-*` and `--storefront-*`, the latter supplied by StorefrontShell),
 * so `tone` picks the palette rather than each caller passing class names and
 * drifting. Both are tokens; neither is a raw colour.
 */
const TONE = {
  dashboard: "border-[color:var(--codiq-border-strong)] text-[color:var(--codiq-text-secondary)]",
  storefront: "border-[color:var(--storefront-border)] text-[color:var(--storefront-muted)]",
} as const;

export function LoadMoreButton({
  cursor,
  busy,
  onLoad,
  testId,
  tone = "dashboard",
}: {
  cursor: string | null;
  busy: boolean;
  onLoad: (cursor: string) => void;
  testId?: string;
  tone?: keyof typeof TONE;
}) {
  if (!cursor) return null;
  return (
    <div className="flex justify-center pt-1">
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        data-testid={testId}
        onClick={() => onLoad(cursor)}
        className={`rounded-xl ${TONE[tone]}`}
      >
        {busy ? (
          <LoaderCircle className="ml-2 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="ml-2 h-4 w-4" />
        )}
        تحميل المزيد
      </Button>
    </div>
  );
}
