/**
 * Marketplace M9 — «عجلة الجوائز»: the wheel (labels only — the draw is the
 * server's), spins left and when the next free one comes, the result with a
 * picture to share, «الجوائز مالتك» with claiming, «ترتيب الفائزين», the log.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { CircleAlert, Gift, LoaderCircle, Medal, Share2, Sparkles, Trophy } from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";
import { marketGet } from "../market-api";
import { useMarketList } from "../use-market-list";
import { Countdown } from "../components/Countdown";
import { MarketEmptyState } from "../MarketEmptyState";
import { MarketSignIn } from "./MarketAccountPages";

type Segment = { index: number; label: string; kind: string };
type State = { freeLeft: number; bonusLeft: number; spinsLeft: number; nextFreeAt: string | null; wins: number; maxWins: number; reachedMaxWins: boolean };
type WheelPage = { open: boolean; reason: string | null; next: { title: string; startsAt: string } | null; wheel: { slug: string; title: string; howToPlay: string | null; endsAt: string; dailyFreeSpins: number; iqdPerExtraSpin: number; claimDays: number } | null; segments: Segment[]; codesGone: boolean; state: State | null };
type SpinResult = { segmentIndex: number; prize: { label: string; kind: string }; win: { id: string; claimBy: string } | null; message: string; state: State };
type Win = { id: string; status: string; statusLabel: string; claimBy: string; wonAt: string; prize: { label: string; kind: string; points: number | null; couponTitle: string | null }; code: string | null };

const tab = (on: boolean) => `rounded-full px-3 py-1.5 text-xs font-bold ${on ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`;
const SEGMENT_TONES = ["var(--codiq-accent)", "var(--codiq-accent-soft)", "var(--codiq-warning-soft)", "var(--codiq-success-soft)"];

function WheelDisk({ segments, rotation }: { segments: Segment[]; rotation: number }) {
  const count = Math.max(segments.length, 1);
  const slice = 360 / count;
  const point = (angle: number, radius: number) => [100 + radius * Math.sin((angle * Math.PI) / 180), 100 - radius * Math.cos((angle * Math.PI) / 180)];
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[320px]">
      <span className="absolute left-1/2 top-0 z-10 -translate-x-1/2 border-x-[12px] border-t-[20px] border-x-transparent border-t-[var(--codiq-danger)]" aria-hidden="true" />
      <svg viewBox="0 0 200 200" className="h-full w-full drop-shadow" style={{ transform: `rotate(${rotation}deg)`, transition: "transform 4s cubic-bezier(0.17, 0.67, 0.2, 1)" }} role="img" aria-label="عجلة الجوائز">
        {segments.map((segment, index) => {
          const [x1, y1] = point(index * slice, 96);
          const [x2, y2] = point((index + 1) * slice, 96);
          const [tx, ty] = point(index * slice + slice / 2, 62);
          return (
            <g key={segment.index}>
              <path d={`M100,100 L${x1},${y1} A96,96 0 ${slice > 180 ? 1 : 0},1 ${x2},${y2} Z`} fill={SEGMENT_TONES[index % SEGMENT_TONES.length]} stroke="var(--codiq-surface)" strokeWidth="1.5" />
              <text x={tx} y={ty} fontSize="9" fontWeight="800" textAnchor="middle" dominantBaseline="middle" fill={index % SEGMENT_TONES.length === 0 ? "var(--codiq-surface)" : "var(--codiq-text)"} transform={`rotate(${index * slice + slice / 2} ${tx} ${ty})`}>{segment.label}</text>
            </g>
          );
        })}
        <circle cx="100" cy="100" r="14" fill="var(--codiq-surface)" stroke="var(--codiq-accent)" strokeWidth="3" />
      </svg>
    </div>
  );
}

/** A picture of the win, drawn here, to save or share («صورة للستوري»). */
async function winPicture(title: string, prize: string): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = 1080; canvas.height = 1920;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--codiq-accent").trim() || "currentColor";
  const surface = css.getPropertyValue("--codiq-surface").trim() || "white";
  context.fillStyle = accent; context.fillRect(0, 0, 1080, 1920);
  context.fillStyle = surface; context.textAlign = "center"; context.direction = "rtl";
  context.font = "bold 72px sans-serif"; context.fillText(title, 540, 640);
  context.font = "bold 120px sans-serif"; context.fillText("ربحت!", 540, 900);
  context.font = "bold 96px sans-serif"; context.fillText(prize, 540, 1100);
  context.font = "48px sans-serif"; context.fillText("جرّب حظّك أنت أيضاً", 540, 1400);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

export function MarketWheelPage() {
  const { shopper } = useShopper();
  const which = new URLSearchParams(useSearch()).get("tab") ?? "wheel";
  const [, navigate] = useLocation();
  const [page, setPage] = useState<WheelPage | null>(null);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<SpinResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const turns = useRef(0);
  const load = useCallback(() => marketGet<WheelPage>("/api/market/wheel").then(setPage).catch((error: Error) => setFailure(error.message)), []);
  useEffect(() => { void load(); }, [load, shopper]);

  async function spin() {
    if (!shopper) { navigate("/account"); return; }
    if (!page || spinning) return;
    setSpinning(true); setResult(null); setFailure(null);
    try {
      const outcome = await accountCall<SpinResult>("/api/market/wheel/spin", { method: "POST" });
      const slice = 360 / Math.max(page.segments.length, 1);
      const target = outcome.segmentIndex >= 0 ? outcome.segmentIndex : 0;
      turns.current += 5;
      // Stop with the chosen segment's middle under the pointer at the top.
      setRotation(turns.current * 360 + (360 - (target * slice + slice / 2)));
      window.setTimeout(() => { setResult(outcome); setSpinning(false); setPage((current) => (current ? { ...current, state: outcome.state } : current)); }, 4100);
    } catch (error) {
      setFailure((error as Error).message); setSpinning(false); void load();
    }
  }
  async function share() {
    if (!result || !page?.wheel) return;
    const blob = await winPicture(page.wheel.title, result.prize.label);
    if (!blob) return;
    const file = new File([blob], "win.png", { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: page.wheel.title, url: `${location.origin}/market/wheel` }).catch(() => undefined); return; }
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "win.png"; link.click();
  }

  if (!page) return failure ? <MarketEmptyState icon={Sparkles} title="تعذّر تحميل العجلة" body={failure} /> : <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  if (!page.open || !page.wheel) return <MarketEmptyState icon={Sparkles} title="العجلة مسكّرة" body={page.next ? `تفتح «${page.next.title}» قريباً.` : "تابعنا، تفتح العجلة في المواسم والحملات."} testId="market-wheel-closed" />;
  const state = page.state;
  return (
    <div className="space-y-4" data-testid="market-wheel">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">{page.wheel.title}</h1>
      <div className="flex flex-wrap gap-2">
        {[["wheel", "العجلة"], ["prizes", "الجوائز مالتك"], ["board", "الترتيب"]].map(([value, label]) => <button key={value} type="button" aria-pressed={which === value} onClick={() => navigate(value === "wheel" ? "/wheel" : `/wheel?tab=${value}`)} className={tab(which === value)} data-testid={`market-wheel-tab-${value}`}>{label}</button>)}
      </div>
      {which === "prizes" ? <WheelPrizes /> : which === "board" ? <WheelBoard /> : (
        <>
          {page.codesGone ? <p className="rounded-2xl bg-[var(--codiq-warning-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-warning)]" data-testid="market-wheel-codes-gone">الأكواد خلصت لهذا الموسم — تابعنا لجوائز جديدة.</p> : null}
          <WheelDisk segments={page.segments} rotation={rotation} />
          {shopper && state ? (
            <p className="text-center text-sm font-bold text-[var(--codiq-text)]" data-testid="market-wheel-left">
              {state.spinsLeft ? `باقيلك ${state.spinsLeft.toLocaleString("ar-IQ")} لفّة` : <>لفّات جديدة بعد <Countdown until={state.nextFreeAt ?? page.wheel.endsAt} /></>}
            </p>
          ) : null}
          <button type="button" disabled={spinning || Boolean(shopper && state && !state.spinsLeft)} onClick={() => void spin()} className="flex w-full items-center justify-center gap-2 rounded-full bg-[var(--codiq-accent)] py-3.5 text-base font-black text-[var(--codiq-surface)] disabled:opacity-50" data-testid="market-wheel-spin">
            {spinning ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />} {shopper ? "لفّ العجلة" : "سجّل الدخول لتلعب"}
          </button>
          {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-wheel-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
          {result ? (
            <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 text-center shadow-sm" data-testid="market-wheel-result">
              {result.win ? <Gift className="mx-auto h-8 w-8 text-[var(--codiq-accent)]" /> : null}
              <p className="text-lg font-black text-[var(--codiq-text)]" data-testid="market-wheel-result-prize">{result.prize.label}</p>
              <p className="text-xs text-[var(--codiq-text-secondary)]">{result.message}</p>
              {result.win ? (
                <div className="flex gap-2">
                  <Link href="/wheel?tab=prizes" className="flex-1 rounded-full bg-[var(--codiq-accent)] py-2.5 text-sm font-bold text-[var(--codiq-surface)]" data-testid="market-wheel-claim-link">استلم جائزتك</Link>
                  <button type="button" onClick={() => void share()} className="inline-flex items-center gap-1 rounded-full border border-[var(--codiq-border)] px-4 text-sm font-bold text-[var(--codiq-text)]" data-testid="market-wheel-share"><Share2 className="h-4 w-4" /> شارك</button>
                </div>
              ) : null}
            </section>
          ) : null}
          <section className="space-y-1 rounded-[24px] bg-[var(--codiq-surface)] p-4 text-xs leading-6 text-[var(--codiq-text-secondary)] shadow-sm" data-testid="market-wheel-how">
            <p className="text-sm font-black text-[var(--codiq-text)]">شلون تلعب؟</p>
            {page.wheel.howToPlay ? <p className="whitespace-pre-line">{page.wheel.howToPlay}</p> : null}
            <p>لك {page.wheel.dailyFreeSpins.toLocaleString("ar-IQ")} لفّة مجانيّة كلّ يوم، ولفّة إضافيّة عن كلّ {page.wheel.iqdPerExtraSpin.toLocaleString("ar-IQ")} دينار في طلب يصلك.</p>
            <p>استلم جائزتك خلال {page.wheel.claimDays.toLocaleString("ar-IQ")} أيّام من ربحها.</p>
            <Link href="/wheel/log" className="font-bold text-[var(--codiq-accent)]">سجلّ لفّاتي</Link>
          </section>
        </>
      )}
    </div>
  );
}

function WheelPrizes() {
  const { shopper } = useShopper();
  const [generation, setGeneration] = useState(0);
  const list = useMarketList<Win>(shopper ? `/api/market/wheel/wins?g=${generation}` : null, "wins");
  const [addresses, setAddresses] = useState<{ id: string; label: string }[]>([]);
  const [addressId, setAddressId] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (shopper) void accountCall<{ addresses: { id: string; label: string; isDefault: boolean }[] }>("/api/market/me/addresses").then((body) => { setAddresses(body.addresses); setAddressId(body.addresses.find((row) => row.isDefault)?.id ?? body.addresses[0]?.id ?? ""); }).catch(() => undefined); }, [shopper]);
  if (!shopper) return <MarketSignIn />;
  async function claim(win: Win) {
    try { await accountCall(`/api/market/wheel/wins/${win.id}/claim`, { method: "POST", body: JSON.stringify(win.prize.kind === "physical" ? { addressId } : {}) }); setFailure(null); setGeneration((value) => value + 1); } catch (error) { setFailure((error as Error).message); }
  }
  return (
    <div className="space-y-3" data-testid="market-wheel-prizes">
      {failure ? <p className="rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]">{failure}</p> : null}
      {!list.items ? <LoaderCircle className="mx-auto h-5 w-5 animate-spin" /> : list.items.length === 0 ? <MarketEmptyState icon={Gift} title="ما ربحت جوائز بعد" body="لفّ العجلة، جائزتك قريبة." /> : null}
      {list.items?.map((win) => (
        <div key={win.id} className="space-y-1.5 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid={`market-wheel-win-${win.id}`}>
          <div className="flex items-center justify-between"><p className="text-sm font-black text-[var(--codiq-text)]">{win.prize.label}</p><span className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-accent)]" data-testid={`market-wheel-win-status-${win.id}`}>{win.statusLabel}</span></div>
          {win.code ? <p className="text-xs text-[var(--codiq-text-secondary)]">الكود: <span dir="ltr" className="font-mono font-black">{win.code}</span> — موجود في <Link href="/coupons?tab=active" className="font-bold text-[var(--codiq-accent)]">كوبوناتك</Link></p> : null}
          {win.status === "pending" ? (
            <>
              <p className="text-[11px] text-[var(--codiq-text-muted)]">استلمها قبل {new Date(win.claimBy).toLocaleDateString("ar-IQ")}</p>
              {win.prize.kind === "physical" ? <select value={addressId} onChange={(event) => setAddressId(event.target.value)} className="w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm">{addresses.map((address) => <option key={address.id} value={address.id}>{address.label}</option>)}</select> : null}
              <button type="button" onClick={() => void claim(win)} className="w-full rounded-full bg-[var(--codiq-accent)] py-2.5 text-sm font-bold text-[var(--codiq-surface)]" data-testid={`market-wheel-claim-${win.id}`}>استلم</button>
            </>
          ) : null}
        </div>
      ))}
      {list.nextCursor ? <button type="button" onClick={() => void list.loadMore()} className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]">عرض المزيد</button> : null}
    </div>
  );
}

function WheelBoard() {
  const [board, setBoard] = useState<{ board: { rank: number; name: string; wins: number; isMe: boolean }[]; me: { rank: number | null; wins: number } | null } | null>(null);
  useEffect(() => { void marketGet<NonNullable<typeof board>>("/api/market/wheel/board").then(setBoard).catch(() => undefined); }, []);
  const medal = useMemo(() => ["var(--codiq-warning)", "var(--codiq-text-muted)", "var(--codiq-accent)"], []);
  if (!board) return <LoaderCircle className="mx-auto h-5 w-5 animate-spin" />;
  return (
    <div className="space-y-3" data-testid="market-wheel-board">
      {board.me ? <p className="rounded-[20px] bg-[var(--codiq-accent-soft)] p-3 text-center text-sm font-bold text-[var(--codiq-accent)]" data-testid="market-wheel-my-rank"><Medal className="ml-1 inline h-4 w-4" /> {board.me.rank ? `مركزك ${board.me.rank.toLocaleString("ar-IQ")} — ${board.me.wins.toLocaleString("ar-IQ")} جائزة` : "لم تربح بعد — مركزك ينتظرك"}</p> : null}
      {board.board.length === 0 ? <MarketEmptyState icon={Trophy} title="لا فائزين بعد" body="كن أوّل الفائزين." /> : (
        <ol className="divide-y divide-[var(--codiq-border)] overflow-hidden rounded-[22px] bg-[var(--codiq-surface)] shadow-sm">
          {board.board.map((row) => <li key={`${row.rank}-${row.name}`} className={`flex items-center justify-between gap-2 px-4 py-2.5 text-sm ${row.isMe ? "bg-[var(--codiq-accent-soft)] font-bold" : ""}`}><span className="flex items-center gap-2"><span className="w-6 text-center font-black" style={row.rank <= 3 ? { color: medal[row.rank - 1] } : undefined}>{row.rank.toLocaleString("ar-IQ")}</span>{row.name}</span><span className="text-xs text-[var(--codiq-text-secondary)]">{row.wins.toLocaleString("ar-IQ")} جائزة</span></li>)}
        </ol>
      )}
    </div>
  );
}

export function MarketWheelLogPage() {
  const { status, shopper } = useShopper();
  const list = useMarketList<{ id: string; kind: string; prizeLabel: string; won: boolean; at: string }>(shopper ? "/api/market/wheel/spins" : null, "spins");
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  return (
    <div className="space-y-4" data-testid="market-wheel-log">
      <Link href="/wheel" className="text-xs font-bold text-[var(--codiq-accent)]">← العجلة</Link>
      <h1 className="text-xl font-black text-[var(--codiq-text)]">سجلّ لفّاتي</h1>
      {!list.items ? <LoaderCircle className="mx-auto h-5 w-5 animate-spin" /> : list.items.length === 0 ? <MarketEmptyState icon={Sparkles} title="لم تلفّ العجلة بعد" /> : (
        <ul className="divide-y divide-[var(--codiq-border)] overflow-hidden rounded-[22px] bg-[var(--codiq-surface)] shadow-sm">
          {list.items.map((row) => <li key={row.id} className="flex justify-between gap-2 px-4 py-2.5 text-xs"><span><span className={`block font-bold ${row.won ? "text-[var(--codiq-success)]" : "text-[var(--codiq-text)]"}`}>{row.prizeLabel}</span><span className="text-[10px] text-[var(--codiq-text-muted)]">{row.kind === "free" ? "لفّة مجانيّة" : "لفّة من طلب"}</span></span><span className="text-[10px] text-[var(--codiq-text-muted)]">{new Date(row.at).toLocaleString("ar-IQ")}</span></li>)}
        </ul>
      )}
      {list.nextCursor ? <button type="button" onClick={() => void list.loadMore()} className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]">عرض المزيد</button> : null}
    </div>
  );
}
