/** «ينتهي بعد …» — a live countdown to an instant, in days, hours and minutes. */
import { useEffect, useState } from "react";
import { Timer } from "lucide-react";

export function Countdown({ until, testId }: { until: string; testId?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const left = Math.max(0, new Date(until).getTime() - now);
  if (left === 0) return <span className="text-xs font-bold text-[var(--codiq-danger)]" data-testid={testId}>انتهى العرض</span>;
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  const parts = days > 0 ? `${days.toLocaleString("ar-IQ")} يوم و${hours.toLocaleString("ar-IQ")} ساعة` : `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return <span className="inline-flex items-center gap-1 text-xs font-bold text-[var(--codiq-danger)]" data-testid={testId}><Timer className="h-4 w-4" /> ينتهي بعد <span dir="ltr">{parts}</span></span>;
}
