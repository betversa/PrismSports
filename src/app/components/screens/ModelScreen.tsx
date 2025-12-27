// screens/Model/ModelScreen.tsx — FULL REWRITE (UI preserved style + FIXED history plumbing)
// -------------------------------------------------------------------------------------------------
// ✅ Main rows (ML/Spread/Total) pulled from public.ev_plays
// ✅ Props list pulled from public.player_prop_ev_latest
// ✅ History (ML/Spread/Total) uses public.odds_snapshot_history (timestamp column = ts)
// ✅ History (Props) uses public.player_props_history (timestamp column = ts)
// ✅ History charts reuse the SAME odds-only chart logic pattern as OddsScreen:
//    - bucketed to 1-min
//    - charts odds only (line shown in hover)
//    - renders all bookmaker series to visualize movement per book
//
// NOTE:
// - This is a full standalone screen component.
// - If your project uses different column names in ev_plays/player_prop_ev_latest,
//   adjust the "pick*" helpers near the top (they’re intentionally defensive).
//
// -------------------------------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";

/* =========================================================
   TYPES / CONSTANTS
========================================================= */

type Mode = "plays" | "props";
type MarketUi = "ml" | "spread" | "total";

type BookKey = "dk" | "fd" | "mgm" | "pin" | "bol";

const CT_TZ = "America/Chicago";

const BOOK_LOGOS: Record<BookKey, string> = {
  dk: "/books/dk.png",
  fd: "/books/fd.png",
  mgm: "/books/mgm.png",
  pin: "/books/pin.png",
  bol: "/books/bol.png",
};
const BOOKS: BookKey[] = ["dk", "fd", "mgm", "pin", "bol"];

const HDR_LEFT_BG = "bg-[#0b0b0b]";
const HDR_BOOK_BG = "bg-[#303030]";
const HDR_TEXT = "text-[#d0d0d0]";
const HDR_BORDER = "border-[#232323]";

const BOOK_GLOW =
  "drop-shadow(0 1px 0 rgba(0,0,0,0.55)) drop-shadow(0 0 8px rgba(255,255,255,0.10)) drop-shadow(0 0 10px rgba(212,175,55,0.16))";

/* =========================================================
   TIME HELPERS
========================================================= */

function normalizeIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${s}Z`;
  return s;
}

function fmtCTTimeOnly(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function fmtCTDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const n = normalizeIso(iso);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function ctYmdFromIso(iso: string | null | undefined) {
  const n = normalizeIso(iso);
  if (!n) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

function ctTodayYmd() {
  return ctYmdFromIso(new Date().toISOString());
}

function fmtDateBtn(ymd: string) {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function maxIso(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  const an = normalizeIso(a);
  const bn = normalizeIso(b);
  if (!an) return b;
  if (!bn) return a;
  return new Date(an).getTime() >= new Date(bn).getTime() ? a : b;
}

/* =========================================================
   BOOK HELPERS
========================================================= */

function bookKeyFromBookmaker(raw: string): BookKey | null {
  const k = String(raw || "").toLowerCase();
  if (k === "draftkings") return "dk";
  if (k === "fanduel") return "fd";
  if (k === "betmgm") return "mgm";
  if (k === "pinnacle") return "pin";
  if (k === "betonlineag") return "bol";
  return null;
}

function headerFallbackPillDataUri(label: string, w = 92, h = 24) {
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="0" y="0" width="${w}" height="${h}" rx="13" ry="13" fill="#FFFFFF"/>
    <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="13" ry="13" fill="none" stroke="#E5E5E5"/>
    <text x="${w / 2}" y="${Math.floor(h * 0.70)}"
      font-family="Arial, sans-serif" font-size="12" font-weight="700"
      text-anchor="middle" fill="#111111">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.trim())}`;
}

function BookLogoPill({
  src,
  alt,
  fallbackLabel,
  size = "md",
}: {
  src: string;
  alt: string;
  fallbackLabel: string;
  size?: "sm" | "md";
}) {
  const pillH = size === "sm" ? "h-7" : "h-8";
  const imgH = size === "sm" ? "h-4" : "h-5";
  const pillW = size === "sm" ? "w-[92px]" : "w-[96px]";

  return (
    <div
      className={`${pillH} ${pillW} rounded-full bg-white/95 border border-[#e5e5e5] px-3 flex items-center justify-center`}
      title={alt}
    >
      <img
        src={src}
        alt={alt}
        className={`${imgH} w-auto object-contain`}
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).src = headerFallbackPillDataUri(fallbackLabel);
        }}
      />
    </div>
  );
}

function seriesColor(bookmaker: string) {
  const k = String(bookmaker || "").toLowerCase();
  // keep same palette as OddsScreen (nice contrast on dark bg)
  if (k === "draftkings") return "#34d399";
  if (k === "fanduel") return "#60a5fa";
  if (k === "betmgm") return "#d4af37";
  if (k === "pinnacle") return "#f97316";
  if (k === "betonlineag") return "#a78bfa";
  return "#9ca3af";
}

/* =========================================================
   GENERIC HELPERS
========================================================= */

function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function impliedProbFromAmerican(odds: number) {
  if (!Number.isFinite(odds) || odds === 0) return NaN;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function floorToMinuteIso(iso: string) {
  const n = normalizeIso(iso) ?? iso;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return iso;
  d.setSeconds(0, 0);
  return d.toISOString();
}

function fmtCTShortLabel(iso: string) {
  const n = normalizeIso(iso) ?? iso;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function useIsMobile(bp = 640) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`);
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [bp]);
  return isMobile;
}

function safeStr(x: any) {
  return x == null ? "" : String(x);
}

function safeNum(x: any): number | null {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function cap100(x: number | null) {
  if (x == null) return null;
  return Math.max(0, Math.min(100, x));
}

/* =========================================================
   DATA SHAPES (DEFENSIVE)
========================================================= */

// --- EV Plays (ML/spread/total)
type EvPlayRow = {
  id?: string | number;

  run_id?: string | null;
  sport_key?: string | null;

  event_id?: string | null;
  commence_time?: string | null;

  home_team?: string | null;
  away_team?: string | null;

  market?: string | null; // "h2h" | "spreads" | "totals" (or ui variant)
  side?: string | null;   // "home" | "away" | "over" | "under"

  line?: number | null;
  odds?: number | null;

  bookmaker?: string | null;  // snapshot style
  book?: string | null;       // sometimes used
  book_key?: string | null;

  quantum_odds?: number | null;
  quantum?: number | null;

  ev_pct?: number | null; // could be 0.031 or 3.1 depending on your pipeline
  spectrum_ev?: number | null;
  score?: number | null;

  bet_amount?: number | null;
  bet_size?: number | null;
  bet_fraction?: number | null;
  kelly_fraction?: number | null;

  updated_at?: string | null;
  ts?: string | null;
  inserted_at?: string | null;

  // optional extra columns may exist; we ignore
};

// --- Player Props latest (list)
type PlayerPropLatestRow = {
  id?: string | number;

  sport_key?: string | null;
  event_id?: string | null;
  commence_time?: string | null;

  home_team?: string | null;
  away_team?: string | null;

  player_name?: string | null;
  team?: string | null;
  opponent?: string | null;
  position?: string | null;
  picture_url?: string | null;

  market?: string | null; // "player_points" etc
  side?: string | null;   // "over"/"under"
  line?: number | null;
  odds?: number | null;

  bookmaker?: string | null;

  ev_pct?: number | null;
  score?: number | null;

  updated_at?: string | null;
  ts?: string | null;
  inserted_at?: string | null;
};

function pickPlayBookmaker(r: EvPlayRow) {
  return safeStr(r.bookmaker ?? r.book ?? r.book_key ?? "").toLowerCase();
}

function pickPlayTs(r: EvPlayRow) {
  return normalizeIso(r.updated_at ?? r.ts ?? r.inserted_at ?? null);
}

function pickPropTs(r: PlayerPropLatestRow) {
  return normalizeIso(r.updated_at ?? r.ts ?? r.inserted_at ?? null);
}

// normalize EV% display
function formatEvPct(raw: number | null) {
  if (raw == null) return "—";
  // if it looks like 0.03 -> treat as 3.0%
  const v = Math.abs(raw) <= 1.5 ? raw * 100 : raw;
  return `${v.toFixed(2)}%`;
}

function formatScore(raw: number | null) {
  const v = cap100(raw);
  if (v == null) return "—";
  return v.toFixed(0);
}

function uiMarketFromRow(r: { market?: string | null; side?: string | null }): MarketUi {
  const m = safeStr(r.market ?? "").toLowerCase();
  // allow either ui-market or snapshot-market naming
  if (m === "ml" || m === "moneyline" || m === "h2h") return "ml";
  if (m === "spread" || m === "spreads") return "spread";
  if (m === "total" || m === "totals") return "total";
  // fallback heuristic from side
  const s = safeStr(r.side ?? "").toLowerCase();
  if (s === "over" || s === "under") return "total";
  return "ml";
}

function pickTeamLabelForPlay(r: EvPlayRow) {
  const m = uiMarketFromRow(r);
  const side = safeStr(r.side).toLowerCase();
  if (m === "total") return `${r.away_team ?? "Away"} vs ${r.home_team ?? "Home"}`;
  // ml/spread: show one side team only
  if (side === "away") return r.away_team ?? "Away";
  if (side === "home") return r.home_team ?? "Home";
  return `${r.away_team ?? "Away"} vs ${r.home_team ?? "Home"}`;
}

function pickLineDisplay(r: { line?: number | null; market?: string | null; side?: string | null }) {
  const m = uiMarketFromRow(r);
  const line = safeNum(r.line);
  if (line == null) return "—";
  if (m === "ml") return "—";
  return String(line);
}

function pickOddsDisplay(r: { odds?: number | null }) {
  const o = safeNum(r.odds);
  return o == null ? "—" : String(o);
}

function pickQuantumDisplay(r: EvPlayRow | PlayerPropLatestRow) {
  const q = safeNum((r as any).quantum_odds ?? (r as any).quantum);
  return q == null ? "—" : String(q);
}

/* =========================================================
   HISTORY DATA TYPES
========================================================= */

type HistMarket = "h2h" | "spreads" | "totals";
type HistSide = "home" | "away" | "over" | "under";

type OddsHistoryRow = {
  id: number;
  ts: string; // IMPORTANT: timestamp column is ts
  event_id: string;
  bookmaker: string;
  market: HistMarket | string;
  side: HistSide | string;
  line: number | null;
  odds: number | null;
};

type PropsHistoryRow = {
  id: number;
  ts: string; // IMPORTANT: timestamp column is ts
  sport_key: string;
  event_id: string;
  player_name: string;
  market: string;
  side: string; // over/under
  line: number | null;
  odds: number | null;
  bookmaker: string;
};

type ChartPoint = {
  ts: string;
  t: string;
  mw: number | null;
  sharp: boolean;
  pinProb?: number | null;
  [k: string]: any;
};

function medianProbOfKeys(point: any, keys: string[]) {
  const probs: number[] = [];
  for (const k of keys) {
    const odds = point?.[k];
    if (typeof odds === "number" && Number.isFinite(odds)) {
      const p = impliedProbFromAmerican(odds);
      if (Number.isFinite(p)) probs.push(p);
    }
  }
  return median(probs);
}

// Same bucketing/series builder pattern as OddsScreen (odds-only; line in hover)
function buildChartSeriesOddsOnly(rows: Array<{ ts: string; bookmaker: string; odds: number | null; line: number | null }>, uiMarket: MarketUi, books: string[]) {
  const binMap = new Map<string, Map<string, any>>();

  for (const r of rows) {
    const bin = floorToMinuteIso(r.ts);
    const byBook = binMap.get(bin) ?? new Map<string, any>();
    const prev = byBook.get(r.bookmaker);

    if (!prev) byBook.set(r.bookmaker, r);
    else {
      const pt = new Date(normalizeIso(prev.ts) ?? prev.ts).getTime();
      const rt = new Date(normalizeIso(r.ts) ?? r.ts).getTime();
      if (rt >= pt) byBook.set(r.bookmaker, r);
    }

    binMap.set(bin, byBook);
  }

  const bins = Array.from(binMap.keys()).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const points: ChartPoint[] = bins.map((bin) => {
    const byBook = binMap.get(bin)!;
    const p: ChartPoint = { ts: bin, t: fmtCTShortLabel(bin), mw: null, sharp: false };

    for (const b of books) {
      const row = byBook.get(b);
      if (!row) continue;

      if (typeof row.odds === "number" && Number.isFinite(row.odds)) p[b] = row.odds;
      if (typeof row.line === "number" && Number.isFinite(row.line)) p[`${b}__line`] = row.line;
    }

    const probs = books
      .map((b) => p[b])
      .filter((v) => typeof v === "number" && Number.isFinite(v))
      .map((odds: number) => impliedProbFromAmerican(odds))
      .filter((q) => Number.isFinite(q));

    if (probs.length >= 2) p.mw = +(Math.max(...probs) - Math.min(...probs)).toFixed(4);

    const pinOdds = p["pinnacle"];
    if (typeof pinOdds === "number" && Number.isFinite(pinOdds)) {
      const pp = impliedProbFromAmerican(pinOdds);
      p.pinProb = Number.isFinite(pp) ? pp : null;
    } else {
      p.pinProb = null;
    }

    return p;
  });

  const PROB_MOVE = 0.02;
  const widthTight = uiMarket === "ml" ? 0.03 : uiMarket === "spread" ? 0.02 : 0.02;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];

    const widthOk = cur.mw != null ? cur.mw <= widthTight : false;

    let sharp = false;

    if (prev.pinProb != null && cur.pinProb != null) {
      if (Math.abs(cur.pinProb - prev.pinProb) >= PROB_MOVE) sharp = true;
    }

    if (!sharp && widthOk) {
      const consPrev = medianProbOfKeys(prev, books);
      const consCur = medianProbOfKeys(cur, books);
      if (consPrev != null && consCur != null) {
        if (Math.abs(consCur - consPrev) >= PROB_MOVE) sharp = true;
      }
    }

    cur.sharp = sharp;
  }

  return points;
}

/* =========================================================
   MODAL SHELL
========================================================= */

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-7xl rounded-xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="text-white font-extrabold text-sm">{title}</div>
            {subtitle && <div className="text-[11px] text-[#808080] mt-0.5 break-words">{subtitle}</div>}
          </div>
          <button
            className="text-[#cfcfcf] hover:text-white text-sm font-bold px-2 py-1 rounded-md hover:bg-white/10"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="p-3 sm:p-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/* =========================================================
   HISTORY CHART (REUSABLE PANEL)
========================================================= */

function HistoryChartPairOddsOnly({
  title,
  uiMarket,
  books,
  seriesA,
  seriesB,
  panelTitleA,
  panelTitleB,
}: {
  title: string;
  uiMarket: MarketUi;
  books: string[];
  seriesA: ChartPoint[];
  seriesB: ChartPoint[];
  panelTitleA: string;
  panelTitleB: string;
}) {
  const isMobile = useIsMobile();
  const chartHeight = isMobile ? 420 : 520;

  const leftTopLabel = uiMarket === "ml" ? "Moneyline Odds" : uiMarket === "spread" ? "Spread Odds" : "Total Odds";
  const rightTopLabel = "Market Width (Prob)";

  const margin = isMobile ? { top: 8, right: 14, left: 36, bottom: 14 } : { top: 8, right: 16, left: 38, bottom: 16 };
  const xTickSize = isMobile ? 10 : 11;
  const yTickSize = isMobile ? 10 : 11;

  const empty = !seriesA.length && !seriesB.length;

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <div className="text-white font-extrabold text-sm">{title}</div>
      </div>

      {empty ? (
        <div className="p-4 text-xs text-[#808080]">No history rows found in this window for this market.</div>
      ) : (
        <div className="p-3 sm:p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
          {[
            { title: panelTitleA, data: seriesA } as const,
            { title: panelTitleB, data: seriesB } as const,
          ].map((panel) => (
            <div key={panel.title} className="rounded-lg border border-[#2a2a2a] bg-black/20 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-white font-bold text-xs">{panel.title}</div>
                <div className="flex items-center gap-3">
                  <div className="text-[10px] text-[#cfcfcf] font-extrabold">{leftTopLabel}</div>
                  <div className="text-[10px] text-[#cfcfcf] font-extrabold">{rightTopLabel}</div>
                </div>
              </div>

              <div style={{ height: chartHeight }} className="w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={panel.data} margin={margin}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="t" tick={{ fontSize: xTickSize }} interval="preserveStartEnd" />

                    <YAxis yAxisId="main" tick={{ fontSize: yTickSize }} tickMargin={8} width={isMobile ? 36 : 40} />
                    <YAxis yAxisId="mw" orientation="right" tick={{ fontSize: yTickSize }} tickMargin={8} width={isMobile ? 42 : 46} />

                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;

                        const row: any = payload[0]?.payload;

                        const series = (payload ?? [])
                          .filter((p) => p?.dataKey && typeof p.value === "number")
                          .map((p) => ({ key: String(p.dataKey), val: p.value as number }))
                          .filter((x) => x.key !== "mw");

                        const pretty = series.map((s) => {
                          const ln = row?.[`${s.key}__line`];
                          return { book: s.key, odds: s.val, line: typeof ln === "number" ? ln : null };
                        });

                        return (
                          <div className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-md p-2 text-[11px] text-[#cfcfcf] max-w-[340px]">
                            <div className="font-extrabold text-white mb-1">{label}</div>

                            {row?.mw != null && (
                              <div className="mb-1">
                                <span className="font-bold">Width:</span> {row.mw}
                              </div>
                            )}

                            <div className="space-y-0.5">
                              {pretty.slice(0, 12).map((x) => (
                                <div key={x.book} className="flex items-center justify-between gap-2">
                                  <span className="text-[#9a9a9a] font-semibold">{x.book}</span>
                                  <span className="text-white font-extrabold tabular-nums">
                                    {x.odds}
                                    {x.line != null ? <span className="text-white/80"> · {x.line}</span> : null}
                                  </span>
                                </div>
                              ))}
                            </div>

                            <div className="mt-2">
                              {row?.sharp ? (
                                <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-red-500 text-white">
                                  Sharp Move
                                </span>
                              ) : (
                                <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-[#2a2a2a] text-[#cfcfcf]">
                                  —
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      }}
                    />

                    <Legend />

                    {books.map((b) => (
                      <Line
                        key={b}
                        yAxisId="main"
                        type="monotone"
                        dataKey={b}
                        name={b}
                        dot={false}
                        strokeWidth={2}
                        connectNulls
                        stroke={seriesColor(b)}
                      />
                    ))}

                    <Line
                      yAxisId="mw"
                      type="monotone"
                      dataKey="mw"
                      name="Market Width"
                      dot={false}
                      strokeWidth={2}
                      connectNulls
                      stroke="#e5e7eb"
                      strokeDasharray="6 6"
                    />

                    {panel.data
                      .filter((p) => p.sharp)
                      .map((p) => (
                        <ReferenceLine
                          key={`sharp-${panel.title}-${p.ts}`}
                          x={p.t}
                          stroke="rgba(239,68,68,0.55)"
                          strokeDasharray="3 3"
                          yAxisId="main"
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   PROP AVATAR (same reliable img fallback approach)
========================================================= */

function PlayerAvatar({
  url,
  name,
  size = 34,
}: {
  url: string | null | undefined;
  name: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);

  const initials = useMemo(() => {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "—";
    const a = parts[0]?.[0] ?? "";
    const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (a + b).toUpperCase();
  }, [name]);

  if (!url || broken) {
    return (
      <div
        className="rounded-full bg-white/10 border border-[#2a2a2a] flex items-center justify-center text-[11px] font-extrabold text-[#cfcfcf]"
        style={{ width: size, height: size }}
        title={name}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={name}
      width={size}
      height={size}
      className="rounded-full object-cover border border-[#2a2a2a] bg-black/40"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      title={name}
      style={{ width: size, height: size }}
    />
  );
}

/* =========================================================
   HISTORY MODAL — GAME (ML / SPREAD / TOTAL)
   Source: odds_snapshot_history (ts)
========================================================= */

function LineMovementModalGame({
  eventId,
  commenceTime,
  awayTeam,
  homeTeam,
  uiMarketStart,
  onClose,
}: {
  eventId: string;
  commenceTime: string | null;
  awayTeam: string | null;
  homeTeam: string | null;
  uiMarketStart: MarketUi;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [activeMarket, setActiveMarket] = useState<MarketUi>(uiMarketStart);
  useEffect(() => setActiveMarket(uiMarketStart), [uiMarketStart]);

  const hoursBack = 24;
  const [books, setBooks] = useState<string[]>([]);

  const [mlAway, setMlAway] = useState<ChartPoint[]>([]);
  const [mlHome, setMlHome] = useState<ChartPoint[]>([]);
  const [spAway, setSpAway] = useState<ChartPoint[]>([]);
  const [spHome, setSpHome] = useState<ChartPoint[]>([]);
  const [toOver, setToOver] = useState<ChartPoint[]>([]);
  const [toUnder, setToUnder] = useState<ChartPoint[]>([]);

  useEffect(() => {
    let alive = true;

    async function run() {
      setLoading(true);
      setErr("");

      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from("odds_snapshot_history")
        .select("id, ts, event_id, bookmaker, market, side, line, odds")
        .eq("event_id", eventId)
        .gte("ts", since)
        .order("ts", { ascending: true });

      if (!alive) return;

      if (error) {
        setErr(error.message);
        setBooks([]);
        setMlAway([]);
        setMlHome([]);
        setSpAway([]);
        setSpHome([]);
        setToOver([]);
        setToUnder([]);
        setLoading(false);
        return;
      }

      const rowsRaw = (data ?? []) as OddsHistoryRow[];

      const rows = rowsRaw
        .map((r) => ({
          ...r,
          ts: normalizeIso((r as any).ts) ?? safeStr((r as any).ts),
          bookmaker: safeStr(r.bookmaker).toLowerCase(),
          market: safeStr(r.market).toLowerCase(),
          side: safeStr(r.side).toLowerCase(),
        }))
        .filter((r) => !!r.ts);

      const set = new Set<string>();
      for (const r of rows) set.add(String(r.bookmaker || "").toLowerCase());
      const bookList = Array.from(set).sort((a, b) => a.localeCompare(b));
      setBooks(bookList);

      const pick = (m: string, s: string) => rows.filter((r) => r.market === m && r.side === s);

      setMlAway(buildChartSeriesOddsOnly(pick("h2h", "away"), "ml", bookList));
      setMlHome(buildChartSeriesOddsOnly(pick("h2h", "home"), "ml", bookList));

      setSpAway(buildChartSeriesOddsOnly(pick("spreads", "away"), "spread", bookList));
      setSpHome(buildChartSeriesOddsOnly(pick("spreads", "home"), "spread", bookList));

      setToOver(buildChartSeriesOddsOnly(pick("totals", "over"), "total", bookList));
      setToUnder(buildChartSeriesOddsOnly(pick("totals", "under"), "total", bookList));

      setLoading(false);
    }

    run();
    return () => {
      alive = false;
    };
  }, [eventId]);

  const subtitle = [
    commenceTime ? `Commence: ${fmtCTDateTime(commenceTime)}` : null,
    awayTeam && homeTeam ? `${awayTeam} @ ${homeTeam}` : null,
    `Window: last ${hoursBack}h`,
    "Bucket: 1-min",
    "Chart: odds (line in hover)",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ModalShell title="Line Movement" subtitle={subtitle} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
            activeMarket === "ml"
              ? "bg-[#d4af37] text-black border-[#d4af37]"
              : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
          }`}
          onClick={() => setActiveMarket("ml")}
          type="button"
        >
          Moneyline
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
            activeMarket === "spread"
              ? "bg-[#d4af37] text-black border-[#d4af37]"
              : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
          }`}
          onClick={() => setActiveMarket("spread")}
          type="button"
        >
          Spread
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border ${
            activeMarket === "total"
              ? "bg-[#d4af37] text-black border-[#d4af37]"
              : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a]"
          }`}
          onClick={() => setActiveMarket("total")}
          type="button"
        >
          Total
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-[#808080]">Loading snapshots…</div>
      ) : err ? (
        <div className="text-xs text-red-400">Supabase error: {err}</div>
      ) : (
        <div className="space-y-4">
          {activeMarket === "ml" && (
            <HistoryChartPairOddsOnly
              title="Moneyline (Odds)"
              uiMarket="ml"
              books={books}
              seriesA={mlAway}
              seriesB={mlHome}
              panelTitleA="AWAY"
              panelTitleB="HOME"
            />
          )}
          {activeMarket === "spread" && (
            <HistoryChartPairOddsOnly
              title="Spread (Odds)"
              uiMarket="spread"
              books={books}
              seriesA={spAway}
              seriesB={spHome}
              panelTitleA="AWAY"
              panelTitleB="HOME"
            />
          )}
          {activeMarket === "total" && (
            <HistoryChartPairOddsOnly
              title="Total (Odds)"
              uiMarket="total"
              books={books}
              seriesA={toOver}
              seriesB={toUnder}
              panelTitleA="OVER"
              panelTitleB="UNDER"
            />
          )}
        </div>
      )}
    </ModalShell>
  );
}

/* =========================================================
   HISTORY MODAL — PROP (single bet: event+player+market+side+line)
   Source: player_props_history (ts)
========================================================= */

function LineMovementModalProp({
  sportKey,
  eventId,
  commenceTime,
  awayTeam,
  homeTeam,
  playerName,
  market,
  side,
  line,
  onClose,
}: {
  sportKey: string;
  eventId: string;
  commenceTime: string | null;
  awayTeam: string | null;
  homeTeam: string | null;

  playerName: string;
  market: string; // player_points etc
  side: string;   // over/under
  line: number;

  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const hoursBack = 24;

  const [books, setBooks] = useState<string[]>([]);
  const [series, setSeries] = useState<ChartPoint[]>([]);

  useEffect(() => {
    let alive = true;

    async function run() {
      setLoading(true);
      setErr("");

      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from("player_props_history")
        .select("id, ts, sport_key, event_id, player_name, market, side, line, odds, bookmaker")
        .eq("sport_key", sportKey)
        .eq("event_id", eventId)
        .eq("player_name", playerName)
        .eq("market", market)
        .eq("side", side)
        .eq("line", line)
        .gte("ts", since)
        .order("ts", { ascending: true });

      if (!alive) return;

      if (error) {
        setErr(error.message);
        setBooks([]);
        setSeries([]);
        setLoading(false);
        return;
      }

      const rowsRaw = (data ?? []) as PropsHistoryRow[];
      const rows = rowsRaw
        .map((r) => ({
          ...r,
          ts: normalizeIso((r as any).ts) ?? safeStr((r as any).ts),
          bookmaker: safeStr(r.bookmaker).toLowerCase(),
        }))
        .filter((r) => !!r.ts);

      const set = new Set<string>();
      for (const r of rows) set.add(String(r.bookmaker || "").toLowerCase());
      const bookList = Array.from(set).sort((a, b) => a.localeCompare(b));
      setBooks(bookList);

      // For props, we only chart one “side” (over or under) at a fixed line.
      // Use the same odds-only series builder.
      setSeries(buildChartSeriesOddsOnly(rows as any, "total", bookList)); // uiMarket doesn't matter much here
      setLoading(false);
    }

    run();
    return () => {
      alive = false;
    };
  }, [sportKey, eventId, playerName, market, side, line]);

  const subtitle = [
    commenceTime ? `Commence: ${fmtCTDateTime(commenceTime)}` : null,
    awayTeam && homeTeam ? `${awayTeam} @ ${homeTeam}` : null,
    `${playerName} · ${market} · ${side.toUpperCase()} ${line}`,
    `Window: last ${hoursBack}h`,
    "Bucket: 1-min",
    "Chart: odds (line in hover)",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ModalShell title="Prop Movement" subtitle={subtitle} onClose={onClose}>
      {loading ? (
        <div className="text-xs text-[#808080]">Loading snapshots…</div>
      ) : err ? (
        <div className="text-xs text-red-400">Supabase error: {err}</div>
      ) : (
        <div className="space-y-4">
          <HistoryChartPairOddsOnly
            title="Player Prop (Odds)"
            uiMarket="total"
            books={books}
            seriesA={series}
            seriesB={[]}
            panelTitleA="ODDS"
            panelTitleB=""
          />
        </div>
      )}
    </ModalShell>
  );
}

/* =========================================================
   UI: Segments
========================================================= */

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-3 py-1.5 text-xs font-extrabold transition-colors",
        "border border-[#2a2a2a]",
        active
          ? "bg-[#d4af37] text-black border-[#d4af37]"
          : "bg-[#0f0f0f] text-[#d0d0d0] hover:border-[#3a3a3a]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function SegmentedMode({ value, onChange }: { value: Mode; onChange: (v: Mode) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-[#2a2a2a] bg-black/20">
      <SegButton active={value === "plays"} onClick={() => onChange("plays")}>
        Model Plays
      </SegButton>
      <div className="w-px bg-[#2a2a2a]" />
      <SegButton active={value === "props"} onClick={() => onChange("props")}>
        Player Props
      </SegButton>
    </div>
  );
}

/* =========================================================
   SCREEN
========================================================= */

export function ModelScreen({ sportKey }: { sportKey: string }) {
  const [mode, setMode] = useState<Mode>("plays");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [plays, setPlays] = useState<EvPlayRow[]>([]);
  const [props, setProps] = useState<PlayerPropLatestRow[]>([]);

  const [selectedDate, setSelectedDate] = useState<string>("");

  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(null);

  // History modal state
  const [histOpenGame, setHistOpenGame] = useState(false);
  const [histOpenProp, setHistOpenProp] = useState(false);

  const [histGame, setHistGame] = useState<{
    eventId: string;
    commenceTime: string | null;
    awayTeam: string | null;
    homeTeam: string | null;
    uiMarket: MarketUi;
  } | null>(null);

  const [histProp, setHistProp] = useState<{
    sportKey: string;
    eventId: string;
    commenceTime: string | null;
    awayTeam: string | null;
    homeTeam: string | null;
    playerName: string;
    market: string;
    side: string;
    line: number;
  } | null>(null);

  function openGameHistory(r: EvPlayRow) {
    const eventId = safeStr(r.event_id);
    if (!eventId) return;

    setHistGame({
      eventId,
      commenceTime: r.commence_time ?? null,
      awayTeam: r.away_team ?? null,
      homeTeam: r.home_team ?? null,
      uiMarket: uiMarketFromRow(r),
    });
    setHistOpenGame(true);
  }

  function openPropHistory(r: PlayerPropLatestRow) {
    const eventId = safeStr(r.event_id);
    const playerName = safeStr(r.player_name);
    const market = safeStr(r.market);
    const side = safeStr(r.side).toLowerCase();
    const line = safeNum(r.line);

    if (!eventId || !playerName || !market || (side !== "over" && side !== "under") || line == null) return;

    setHistProp({
      sportKey,
      eventId,
      commenceTime: r.commence_time ?? null,
      awayTeam: r.away_team ?? null,
      homeTeam: r.home_team ?? null,
      playerName,
      market,
      side,
      line,
    });
    setHistOpenProp(true);
  }

  function closeHistory() {
    setHistOpenGame(false);
    setHistOpenProp(false);
    setHistGame(null);
    setHistProp(null);
  }

  async function load() {
    setError("");

    // We'll load both lists every refresh so switching tabs feels instant.
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    // ---- Plays: ev_plays
    const playsRes = await supabase
      .from("ev_plays")
      .select("*")
      .eq("sport_key", sportKey)
      .order("commence_time", { ascending: true })
      .limit(5000);

    if (playsRes.error) {
      setError(playsRes.error.message);
      setPlays([]);
      setProps([]);
      setLastUpdatedIso(null);
      setLoading(false);
      return;
    }

    const playsRaw = (playsRes.data ?? []) as EvPlayRow[];

    // only keep future games for today (same convention as your other screens)
    const playsClean = playsRaw.filter((r) => {
      const ct = ctYmdFromIso(r.commence_time ?? null);
      if (!ct) return false;
      const startMs = new Date(normalizeIso(r.commence_time ?? null) ?? (r.commence_time ?? "")).getTime();
      if (!Number.isFinite(startMs)) return false;

      // show only future for today; allow future dates
      const todayCt = ctTodayYmd();
      if (ct === todayCt) return startMs > nowMs;
      return startMs > nowMs;
    });

    // ---- Props: player_prop_ev_latest
    const propsRes = await supabase
      .from("player_prop_ev_latest")
      .select("*")
      .eq("sport_key", sportKey)
      .order("commence_time", { ascending: true })
      .limit(5000);

    if (propsRes.error) {
      setError(propsRes.error.message);
      setPlays(playsClean);
      setProps([]);
      setLastUpdatedIso(maxIso(null, playsClean.map(pickPlayTs).reduce((a, b) => maxIso(a, b), null)));
      setLoading(false);
      return;
    }

    const propsRaw = (propsRes.data ?? []) as PlayerPropLatestRow[];

    const propsClean = propsRaw.filter((r) => {
      const startMs = new Date(normalizeIso(r.commence_time ?? null) ?? (r.commence_time ?? "")).getTime();
      if (!Number.isFinite(startMs)) return false;
      return startMs > nowMs;
    });

    // Last updated: max of plays + props “updated-ish”
    let latest: string | null = null;
    for (const r of playsClean) latest = maxIso(latest, pickPlayTs(r));
    for (const r of propsClean) latest = maxIso(latest, pickPropTs(r));
    latest = maxIso(latest, normalizeIso(nowIso)); // keep “fresh” feel even if tables don’t store timestamps

    setPlays(playsClean);
    setProps(propsClean);
    setLastUpdatedIso(latest);

    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportKey]);

  // date pills (based on whichever mode is active, but computed for both)
  const availableDates = useMemo(() => {
    const set = new Set<string>();
    const src = mode === "plays" ? plays : props;

    for (const r of src as any[]) {
      const ymd = ctYmdFromIso(r.commence_time ?? null);
      if (ymd) set.add(ymd);
    }

    return Array.from(set).sort();
  }, [mode, plays, props]);

  useEffect(() => {
    if (!availableDates.length) {
      setSelectedDate("");
      return;
    }
    const today = ctTodayYmd();
    setSelectedDate((prev) => {
      if (prev && availableDates.includes(prev)) return prev;
      if (availableDates.includes(today)) return today;
      return availableDates[0];
    });
  }, [availableDates]);

  const playsForDate = useMemo(() => {
    if (!selectedDate) return [];
    return plays.filter((r) => ctYmdFromIso(r.commence_time ?? null) === selectedDate);
  }, [plays, selectedDate]);

  const propsForDate = useMemo(() => {
    if (!selectedDate) return [];
    return props.filter((r) => ctYmdFromIso(r.commence_time ?? null) === selectedDate);
  }, [props, selectedDate]);

  const sportLabel =
    sportKey === "basketball_nba"
      ? "NBA Model"
      : sportKey === "basketball_ncaab"
      ? "NCAAB Model"
      : sportKey === "football_nfl"
      ? "NFL Model"
      : sportKey === "football_ncaaf"
      ? "NCAAF Model"
      : sportKey === "icehockey_nhl"
      ? "NHL Model"
      : sportKey === "baseball_mlb"
      ? "MLB Model"
      : "Model";

  // UI helpers for table headers (kept simple; you can align to your existing visuals)
  function TableHeaderCell({
    children,
    align = "left",
    className = "",
  }: {
    children: React.ReactNode;
    align?: "left" | "center" | "right";
    className?: string;
  }) {
    return (
      <th
        className={[
          "px-4 py-3 text-[12px] font-extrabold border-b",
          HDR_BORDER,
          HDR_LEFT_BG,
          HDR_TEXT,
          align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left",
          className,
        ].join(" ")}
      >
        {children}
      </th>
    );
  }

  return (
    <div className="w-full">
      <div className="max-w-[1320px] mx-auto px-4 md:px-8">
        <div className="pt-4 md:pt-6">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
            <div>
              <h2 className="text-[22px] md:text-[28px] text-white font-extrabold tracking-tight">{sportLabel}</h2>
              <div className="text-xs text-[#8a8a8a] mt-1">
                {mode === "plays" ? "ML / Spread / Total (ev_plays)" : "Player props (player_prop_ev_latest)"} · refresh 60s
              </div>

              <div className="md:hidden mt-2 text-[11px] text-[#6a6a6a] font-semibold">
                Last Updated (CT): <span className="text-white font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</span>
              </div>
            </div>

            <div className="hidden md:block text-right">
              <div className="text-[10px] text-[#6a6a6a] font-semibold">Last Updated (CT)</div>
              <div className="text-xs text-white flex items-center justify-end gap-2">
                <span className="font-extrabold">{fmtCTDateTime(lastUpdatedIso)}</span>
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedMode value={mode} onChange={setMode} />
            </div>

            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
              {availableDates.map((d) => (
                <button
                  key={d}
                  onClick={() => setSelectedDate(d)}
                  className={[
                    "px-3 py-1.5 rounded-lg text-xs border transition-colors whitespace-nowrap font-extrabold",
                    selectedDate === d
                      ? "bg-[#d4af37] text-black border-[#d4af37]"
                      : "bg-black/20 text-[#d0d0d0] border-[#2a2a2a] hover:border-[#3a3a3a]",
                  ].join(" ")}
                  title={d}
                  type="button"
                >
                  {fmtDateBtn(d)}
                </button>
              ))}

              {!availableDates.length && <div className="text-xs text-[#808080]">No games available.</div>}
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] overflow-hidden shadow-[0_16px_60px_rgba(0,0,0,0.38)]">
          {loading ? (
            <div className="p-4 md:p-8 text-xs md:text-sm text-[#808080]">Loading…</div>
          ) : error ? (
            <div className="p-4 md:p-8 text-xs md:text-sm text-red-400">Supabase error: {error}</div>
          ) : mode === "plays" ? (
            <>
              {/* PLAYS — Desktop */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full">
                  <thead className="sticky top-0 z-20">
                    <tr>
                      <TableHeaderCell>Matchup</TableHeaderCell>
                      <TableHeaderCell align="center">Time</TableHeaderCell>
                      <TableHeaderCell align="center">Market</TableHeaderCell>
                      <TableHeaderCell align="center">Pick</TableHeaderCell>
                      <TableHeaderCell align="center">Line</TableHeaderCell>
                      <TableHeaderCell align="center">
                        <div className="flex items-center justify-center gap-2">
                          <img src="/logos/Quantum.png" className="h-4 w-auto" alt="Quantum" />
                          <span>Quantum</span>
                        </div>
                      </TableHeaderCell>
                      <TableHeaderCell align="center">Book</TableHeaderCell>
                      <TableHeaderCell align="center">
                        <div className="flex items-center justify-center gap-2">
                          <img src="/logos/SpectrumEV.png" className="h-4 w-auto" alt="SpectrumEV" />
                          <span>EV%</span>
                        </div>
                      </TableHeaderCell>
                      <TableHeaderCell align="center">Score</TableHeaderCell>
                      <TableHeaderCell align="center">Bet $</TableHeaderCell>
                      <TableHeaderCell align="center">History</TableHeaderCell>
                    </tr>
                  </thead>

                  <tbody>
                    {!playsForDate.length ? (
                      <tr>
                        <td colSpan={11} className="p-6 text-sm text-[#808080]">
                          No model plays for {selectedDate || "—"}.
                        </td>
                      </tr>
                    ) : (
                      playsForDate.map((r, idx) => {
                        const book = pickPlayBookmaker(r);
                        const bk = bookKeyFromBookmaker(book);
                        return (
                          <tr key={String(r.id ?? `${idx}-${r.event_id}-${r.market}-${r.side}`)} className={`border-b ${HDR_BORDER} hover:bg-white/5`}>
                            <td className="px-4 py-3 text-white font-extrabold text-[13px]">
                              <div className="truncate">{r.away_team ?? "Away"} @ {r.home_team ?? "Home"}</div>
                            </td>

                            <td className="px-4 py-3 text-center text-[#cfcfcf] font-semibold text-[12px] tabular-nums">
                              {fmtCTTimeOnly(r.commence_time ?? null)} CT
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px]">
                              {uiMarketFromRow(r) === "ml" ? "ML" : uiMarketFromRow(r) === "spread" ? "Spread" : "Total"}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] truncate">
                              {pickTeamLabelForPlay(r)}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {pickLineDisplay(r)}
                              <div className="text-[11px] text-[#9a9a9a] font-semibold tabular-nums mt-0.5">
                                {pickOddsDisplay(r)}
                              </div>
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {pickQuantumDisplay(r)}
                            </td>

                            <td className="px-4 py-3 text-center">
                              {bk ? (
                                <div className="flex justify-center">
                                  <BookLogoPill
                                    src={BOOK_LOGOS[bk]}
                                    alt={book}
                                    fallbackLabel={bk.toUpperCase()}
                                    size="sm"
                                  />
                                </div>
                              ) : (
                                <div className="text-[12px] text-[#cfcfcf] font-bold">{book || "—"}</div>
                              )}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {formatEvPct(safeNum((r as any).ev_pct ?? (r as any).spectrum_ev))}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {formatScore(safeNum((r as any).score))}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {safeNum((r as any).bet_amount ?? (r as any).bet_size) == null
                                ? "—"
                                : `$${safeNum((r as any).bet_amount ?? (r as any).bet_size)!.toFixed(0)}`}
                            </td>

                            <td className="px-4 py-3 text-center">
                              <button
                                type="button"
                                onClick={() => openGameHistory(r)}
                                className="text-[11px] font-extrabold text-[#d4af37] hover:underline"
                                title="View line movement"
                              >
                                History
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* PLAYS — Mobile */}
              <div className="md:hidden p-3 space-y-3">
                {!playsForDate.length ? (
                  <div className="p-4 text-xs text-[#808080]">No model plays for {selectedDate || "—"}.</div>
                ) : (
                  playsForDate.map((r, idx) => {
                    const book = pickPlayBookmaker(r);
                    const bk = bookKeyFromBookmaker(book);
                    return (
                      <div key={String(r.id ?? `${idx}-${r.event_id}-${r.market}-${r.side}`)} className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
                        <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-white font-extrabold text-[13px] truncate">
                              {r.away_team ?? "Away"} @ {r.home_team ?? "Home"}
                            </div>
                            <div className="text-[11px] text-[#808080] font-semibold mt-0.5">
                              {fmtCTTimeOnly(r.commence_time ?? null)} CT · {uiMarketFromRow(r) === "ml" ? "ML" : uiMarketFromRow(r) === "spread" ? "Spread" : "Total"}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => openGameHistory(r)}
                            className="text-[11px] font-extrabold text-[#d4af37] hover:underline"
                          >
                            History
                          </button>
                        </div>

                        <div className="p-4 grid grid-cols-2 gap-3">
                          <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                            <div className="text-[10px] text-[#808080] font-semibold">Pick</div>
                            <div className="text-white font-extrabold text-[12px] mt-0.5 truncate">{pickTeamLabelForPlay(r)}</div>
                            <div className="text-[11px] text-[#cfcfcf] font-semibold mt-1 tabular-nums">
                              Line: {pickLineDisplay(r)} · Odds: {pickOddsDisplay(r)}
                            </div>
                          </div>

                          <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                            <div className="flex items-center justify-between">
                              <div className="text-[10px] text-[#808080] font-semibold">Book</div>
                              {bk ? (
                                <BookLogoPill src={BOOK_LOGOS[bk]} alt={book} fallbackLabel={bk.toUpperCase()} size="sm" />
                              ) : (
                                <div className="text-[11px] text-[#cfcfcf] font-bold">{book || "—"}</div>
                              )}
                            </div>

                            <div className="mt-2 text-[11px] text-white font-extrabold tabular-nums">
                              EV: {formatEvPct(safeNum((r as any).ev_pct ?? (r as any).spectrum_ev))}
                            </div>
                            <div className="text-[11px] text-white font-extrabold tabular-nums">
                              Score: {formatScore(safeNum((r as any).score))}
                            </div>
                            <div className="text-[11px] text-white font-extrabold tabular-nums">
                              Bet: {safeNum((r as any).bet_amount ?? (r as any).bet_size) == null
                                ? "—"
                                : `$${safeNum((r as any).bet_amount ?? (r as any).bet_size)!.toFixed(0)}`}
                            </div>
                          </div>
                        </div>

                        <div className="px-4 pb-4">
                          <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                            <div className="text-[10px] text-[#808080] font-semibold">Quantum</div>
                            <div className="text-white font-extrabold text-[12px] tabular-nums mt-0.5">
                              {pickQuantumDisplay(r)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <>
              {/* PROPS — Desktop */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full">
                  <thead className="sticky top-0 z-20">
                    <tr>
                      <TableHeaderCell>Player</TableHeaderCell>
                      <TableHeaderCell align="center">Time</TableHeaderCell>
                      <TableHeaderCell align="center">Market</TableHeaderCell>
                      <TableHeaderCell align="center">Side</TableHeaderCell>
                      <TableHeaderCell align="center">Line</TableHeaderCell>
                      <TableHeaderCell align="center">Odds</TableHeaderCell>
                      <TableHeaderCell align="center">Book</TableHeaderCell>
                      <TableHeaderCell align="center">
                        <div className="flex items-center justify-center gap-2">
                          <img src="/logos/SpectrumEV.png" className="h-4 w-auto" alt="SpectrumEV" />
                          <span>EV%</span>
                        </div>
                      </TableHeaderCell>
                      <TableHeaderCell align="center">Score</TableHeaderCell>
                      <TableHeaderCell align="center">History</TableHeaderCell>
                    </tr>
                  </thead>

                  <tbody>
                    {!propsForDate.length ? (
                      <tr>
                        <td colSpan={10} className="p-6 text-sm text-[#808080]">
                          No player props for {selectedDate || "—"}.
                        </td>
                      </tr>
                    ) : (
                      propsForDate.map((r, idx) => {
                        const book = safeStr(r.bookmaker).toLowerCase();
                        const bk = bookKeyFromBookmaker(book);
                        const pn = safeStr(r.player_name);
                        const pos = safeStr(r.position);
                        const line = safeNum(r.line);
                        const side = safeStr(r.side).toLowerCase();

                        return (
                          <tr key={String(r.id ?? `${idx}-${r.event_id}-${pn}-${r.market}-${side}-${line}`)} className={`border-b ${HDR_BORDER} hover:bg-white/5`}>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <PlayerAvatar url={r.picture_url ?? null} name={pn || "—"} size={34} />
                                <div className="min-w-0">
                                  <div className="text-white font-extrabold text-[13px] truncate flex items-center gap-2">
                                    <span className="truncate">{pn || "—"}</span>
                                    {pos ? (
                                      <span className="shrink-0 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-white/10 border border-[#2a2a2a] text-[#d0d0d0]">
                                        {pos}
                                      </span>
                                    ) : null}
                                  </div>
                                  <div className="text-[11px] text-[#8a8a8a] font-semibold mt-0.5 truncate">
                                    {(r.team ?? "—")}{r.opponent ? <span className="text-[#6f6f6f]"> vs {r.opponent}</span> : null}
                                  </div>
                                </div>
                              </div>
                            </td>

                            <td className="px-4 py-3 text-center text-[#cfcfcf] font-semibold text-[12px] tabular-nums">
                              {fmtCTTimeOnly(r.commence_time ?? null)} CT
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px]">
                              {safeStr(r.market)}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px]">
                              {side ? side.toUpperCase() : "—"}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {line == null ? "—" : line}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {pickOddsDisplay(r)}
                            </td>

                            <td className="px-4 py-3 text-center">
                              {bk ? (
                                <div className="flex justify-center">
                                  <BookLogoPill src={BOOK_LOGOS[bk]} alt={book} fallbackLabel={bk.toUpperCase()} size="sm" />
                                </div>
                              ) : (
                                <div className="text-[12px] text-[#cfcfcf] font-bold">{book || "—"}</div>
                              )}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {formatEvPct(safeNum((r as any).ev_pct))}
                            </td>

                            <td className="px-4 py-3 text-center text-white font-extrabold text-[12px] tabular-nums">
                              {formatScore(safeNum((r as any).score))}
                            </td>

                            <td className="px-4 py-3 text-center">
                              <button
                                type="button"
                                onClick={() => openPropHistory(r)}
                                className="text-[11px] font-extrabold text-[#d4af37] hover:underline"
                                title="View prop movement"
                              >
                                History
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* PROPS — Mobile */}
              <div className="md:hidden p-3 space-y-3">
                {!propsForDate.length ? (
                  <div className="p-4 text-xs text-[#808080]">No player props for {selectedDate || "—"}.</div>
                ) : (
                  propsForDate.map((r, idx) => {
                    const pn = safeStr(r.player_name);
                    const pos = safeStr(r.position);
                    const line = safeNum(r.line);
                    const side = safeStr(r.side).toLowerCase();
                    const book = safeStr(r.bookmaker).toLowerCase();
                    const bk = bookKeyFromBookmaker(book);

                    return (
                      <div key={String(r.id ?? `${idx}-${r.event_id}-${pn}-${r.market}-${side}-${line}`)} className="rounded-xl border border-[#2a2a2a] bg-black/20 overflow-hidden">
                        <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
                          <div className="min-w-0 flex items-center gap-3">
                            <PlayerAvatar url={r.picture_url ?? null} name={pn || "—"} size={34} />
                            <div className="min-w-0">
                              <div className="text-white font-extrabold text-[13px] truncate flex items-center gap-2">
                                <span className="truncate">{pn || "—"}</span>
                                {pos ? (
                                  <span className="shrink-0 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-white/10 border border-[#2a2a2a] text-[#d0d0d0]">
                                    {pos}
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-[11px] text-[#808080] font-semibold mt-0.5">
                                {fmtCTTimeOnly(r.commence_time ?? null)} CT
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => openPropHistory(r)}
                            className="text-[11px] font-extrabold text-[#d4af37] hover:underline"
                          >
                            History
                          </button>
                        </div>

                        <div className="p-4 grid grid-cols-2 gap-3">
                          <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                            <div className="text-[10px] text-[#808080] font-semibold">Bet</div>
                            <div className="text-white font-extrabold text-[12px] mt-0.5 truncate">
                              {safeStr(r.market)} · {side ? side.toUpperCase() : "—"} {line == null ? "—" : line}
                            </div>
                            <div className="text-[11px] text-[#cfcfcf] font-semibold mt-1 tabular-nums">
                              Odds: {pickOddsDisplay(r)}
                            </div>
                            <div className="text-[11px] text-[#8a8a8a] font-semibold mt-1 truncate">
                              {(r.team ?? "—")}{r.opponent ? <span className="text-[#6f6f6f]"> vs {r.opponent}</span> : null}
                            </div>
                          </div>

                          <div className="rounded-lg border border-[#2a2a2a] bg-black/10 p-3">
                            <div className="flex items-center justify-between">
                              <div className="text-[10px] text-[#808080] font-semibold">Book</div>
                              {bk ? (
                                <BookLogoPill src={BOOK_LOGOS[bk]} alt={book} fallbackLabel={bk.toUpperCase()} size="sm" />
                              ) : (
                                <div className="text-[11px] text-[#cfcfcf] font-bold">{book || "—"}</div>
                              )}
                            </div>

                            <div className="mt-2 text-[11px] text-white font-extrabold tabular-nums">
                              EV: {formatEvPct(safeNum((r as any).ev_pct))}
                            </div>
                            <div className="text-[11px] text-white font-extrabold tabular-nums">
                              Score: {formatScore(safeNum((r as any).score))}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>

        {/* History modals */}
        {histOpenGame && histGame?.eventId && (
          <LineMovementModalGame
            eventId={histGame.eventId}
            commenceTime={histGame.commenceTime}
            awayTeam={histGame.awayTeam}
            homeTeam={histGame.homeTeam}
            uiMarketStart={histGame.uiMarket}
            onClose={closeHistory}
          />
        )}

        {histOpenProp && histProp?.eventId && (
          <LineMovementModalProp
            sportKey={histProp.sportKey}
            eventId={histProp.eventId}
            commenceTime={histProp.commenceTime}
            awayTeam={histProp.awayTeam}
            homeTeam={histProp.homeTeam}
            playerName={histProp.playerName}
            market={histProp.market}
            side={histProp.side}
            line={histProp.line}
            onClose={closeHistory}
          />
        )}

        <div className="h-12" />
      </div>
    </div>
  );
}

