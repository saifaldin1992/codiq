import { useCallback, useRef } from "react";

/**
 * Only the LATEST request may write the screen.
 *
 * A list that reloads when its filter changes fires one request per change. They
 * do not come back in order: switch a segment, a category or a date range twice
 * quickly, let the first request be the slow one, and its answer lands last and
 * paints the FIRST filter's rows under the SECOND filter's heading. A «load
 * more» still in flight when the filter changes appends the old filter's rows to
 * the new list the same way.
 *
 * Usage: call `begin()` at the start of a load and keep the function it returns;
 * after every `await`, write state only while that function answers true.
 *
 *     const begin = useLatestRequest();
 *     const load = useCallback(async () => {
 *       const isCurrent = begin();
 *       const result = await api(...);
 *       if (!isCurrent()) return;
 *       setRows(result.rows);
 *     }, [begin, filter]);
 */
export function useLatestRequest(): () => () => boolean {
  const latest = useRef(0);
  return useCallback(() => {
    latest.current += 1;
    const mine = latest.current;
    return () => latest.current === mine;
  }, []);
}
